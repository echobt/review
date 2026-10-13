import { z } from "zod";
import {
  ApiError, CreateFeedbackRequest, CreateIndexRequest, CreateReviewRequest, CreateTestGenRequest, FeedbackResponse, FindingList,
  IndexResponse, ReviewEvent, ReviewResponse, ScoreRequest, ScoreResponse, TenantConfigBody, TenantConfigResponse, TestGenResponse, routes,
} from "@review/core";

export interface ClientOptions {
  baseUrl: string;
  /** Bearer API key. Never logged. */
  apiKey?: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  /** Retries for idempotent GETs on 429/5xx/network errors (default 3). POST/PUT are never retried. */
  maxRetries?: number;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export class ReviewApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.name = "ReviewApiError";
  }
}

type Route = (typeof routes)[keyof typeof routes];

const retryable = (status: number) => status === 429 || status >= 500;
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class ReviewClient {
  readonly #base: string;
  readonly #key: string | undefined;
  readonly #fetch: typeof globalThis.fetch;
  readonly #timeoutMs: number;
  readonly #maxRetries: number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #random: () => number;

  constructor(opts: ClientOptions) {
    this.#base = new URL(opts.baseUrl).toString().replace(/\/$/, "");
    this.#key = opts.apiKey;
    this.#fetch = opts.fetch ?? globalThis.fetch;
    this.#timeoutMs = opts.timeoutMs ?? 30_000;
    this.#maxRetries = opts.maxRetries ?? 3;
    this.#sleep = opts.sleep ?? defaultSleep;
    this.#random = opts.random ?? Math.random;
  }

  #url(route: Route, id?: string): string {
    return this.#base + route.path.replace(":id", encodeURIComponent(id ?? ""));
  }

  #headers(extra: Record<string, string> = {}): Record<string, string> {
    return { accept: "application/json", ...(this.#key ? { authorization: `Bearer ${this.#key}` } : {}), ...extra };
  }

  /** Full-jitter exponential backoff, honouring a numeric Retry-After when present. */
  #delay(attempt: number, res?: Response): number {
    const ra = Number(res?.headers.get("retry-after"));
    if (Number.isFinite(ra) && ra > 0) return Math.min(ra * 1000, 30_000);
    return Math.floor(this.#random() * Math.min(200 * 2 ** attempt, 5_000));
  }

  async #call<T>(route: Route, out: z.ZodType<T>, opts: { id?: string; body?: unknown } = {}): Promise<T> {
    const idempotent = route.method === "GET";
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.#fetch(this.#url(route, opts.id), {
          method: route.method,
          headers: this.#headers(opts.body === undefined ? {} : { "content-type": "application/json" }),
          body: opts.body === undefined ? null : JSON.stringify(opts.body),
          signal: AbortSignal.timeout(this.#timeoutMs),
        });
      } catch (e) {
        if (!idempotent || attempt >= this.#maxRetries) throw e;
        await this.#sleep(this.#delay(attempt));
        continue;
      }
      if (idempotent && retryable(res.status) && attempt < this.#maxRetries) {
        await res.body?.cancel();
        await this.#sleep(this.#delay(attempt, res));
        continue;
      }
      const json: unknown = await res.json().catch(() => undefined);
      if (!res.ok) {
        const err = ApiError.safeParse(json);
        throw new ReviewApiError(res.status, err.success ? err.data.error.code : "http_error",
          err.success ? err.data.error.message : `HTTP ${res.status}`);
      }
      return out.parse(json);
    }
  }

  async createReview(req: z.input<typeof CreateReviewRequest>) {
    return this.#call(routes.createReview, ReviewResponse, { body: CreateReviewRequest.parse(req) });
  }
  async getReview(id: string) { return this.#call(routes.getReview, ReviewResponse, { id }); }
  async listFindings(reviewId: string) { return (await this.#call(routes.listFindings, FindingList, { id: reviewId })).findings; }
  async createFeedback(findingId: string, req: z.input<typeof CreateFeedbackRequest>) {
    return this.#call(routes.createFeedback, FeedbackResponse, { id: findingId, body: CreateFeedbackRequest.parse(req) });
  }
  async getConfig() { return this.#call(routes.getConfig, TenantConfigResponse); }
  async putConfig(cfg: z.input<typeof TenantConfigBody>) {
    return this.#call(routes.putConfig, TenantConfigResponse, { body: TenantConfigBody.parse(cfg) });
  }
  async createIndex(req: z.input<typeof CreateIndexRequest>) {
    return this.#call(routes.createIndex, IndexResponse, { body: CreateIndexRequest.parse(req) });
  }
  async getIndex(id: string) { return this.#call(routes.getIndex, IndexResponse, { id }); }
  async createTestGen(req: z.input<typeof CreateTestGenRequest>) {
    return this.#call(routes.createTestGen, TestGenResponse, { body: CreateTestGenRequest.parse(req) });
  }
  async getTestGen(id: string) { return this.#call(routes.getTestGen, TestGenResponse, { id }); }
  /** Enqueue scoring; returns a ScoreJob. Poll getScore(job.id) for the report. */
  async score(req: z.input<typeof ScoreRequest>) {
    return this.#call(routes.score, ScoreResponse, { body: ScoreRequest.parse(req) });
  }
  async getScore(id: string) { return this.#call(routes.getScore, ScoreResponse, { id }); }

  /**
   * Stream review events (SSE). Ends after a "completed" or "error" event. If the stream drops before that,
   * reconnects once with Last-Event-ID so the server can resume after the last delivered event.
   */
  async *reviewEvents(id: string, signal?: AbortSignal): AsyncGenerator<ReviewEvent> {
    let lastId: string | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await this.#fetch(this.#url(routes.reviewEvents, id), {
        headers: this.#headers({ accept: "text/event-stream", ...(lastId ? { "last-event-id": lastId } : {}) }),
        ...(signal ? { signal } : {}),
      });
      if (!res.ok || !res.body) throw new ReviewApiError(res.status, "sse_error", `HTTP ${res.status}`);
      try {
        for await (const msg of parseSseEvents(res.body)) {
          if (msg.id !== undefined) lastId = msg.id;
          const ev = ReviewEvent.parse(JSON.parse(msg.data));
          yield ev;
          if (ev.type === "completed" || ev.type === "error") return;
        }
      } catch (e) {
        if (signal?.aborted || e instanceof z.ZodError || e instanceof SyntaxError) throw e;
      }
    }
    throw new ReviewApiError(0, "sse_dropped", `event stream for ${id} ended before completion`);
  }
}

export interface SseMessage { data: string; id?: string; event?: string }

/** Minimal SSE parser: yields each event's joined `data:` payload plus its `id:`/`event:` fields. */
export async function* parseSseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<SseMessage> {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true });
    let idx: number;
    while ((idx = buf.search(/\r?\n\r?\n/)) !== -1) {
      const lines = buf.slice(0, idx).split(/\r?\n/);
      buf = buf.slice(idx).replace(/^\r?\n\r?\n/, "");
      const field = (name: string) => lines.filter((l) => l.startsWith(`${name}:`)).map((l) => l.slice(name.length + 1).replace(/^ /, ""));
      const data = field("data").join("\n");
      const id = field("id").at(-1), event = field("event").at(-1);
      if (data) yield { data, ...(id !== undefined ? { id } : {}), ...(event !== undefined ? { event } : {}) };
    }
  }
}

/** Back-compat: data payloads only. */
export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  for await (const m of parseSseEvents(body)) yield m.data;
}
