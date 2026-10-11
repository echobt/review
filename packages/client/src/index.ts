import { z } from "zod";
import {
  ApiError, CreateIndexRequest, CreateReviewRequest, CreateTestGenRequest, IndexResponse,
  ReviewEvent, ReviewResponse, ScoreRequest, ScoreResponse, TestGenResponse, routes,
} from "@review/core";

export interface ClientOptions {
  baseUrl: string;
  /** Bearer API key. Never logged. */
  apiKey?: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
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

export class ReviewClient {
  readonly #base: string;
  readonly #key: string | undefined;
  readonly #fetch: typeof globalThis.fetch;
  readonly #timeoutMs: number;

  constructor(opts: ClientOptions) {
    this.#base = new URL(opts.baseUrl).toString().replace(/\/$/, "");
    this.#key = opts.apiKey;
    this.#fetch = opts.fetch ?? globalThis.fetch;
    this.#timeoutMs = opts.timeoutMs ?? 30_000;
  }

  #url(route: Route, id?: string): string {
    return this.#base + route.path.replace(":id", encodeURIComponent(id ?? ""));
  }

  #headers(extra: Record<string, string> = {}): Record<string, string> {
    return { accept: "application/json", ...(this.#key ? { authorization: `Bearer ${this.#key}` } : {}), ...extra };
  }

  async #call<T>(route: Route, out: z.ZodType<T>, opts: { id?: string; body?: unknown } = {}): Promise<T> {
    const res = await this.#fetch(this.#url(route, opts.id), {
      method: route.method,
      headers: this.#headers(opts.body === undefined ? {} : { "content-type": "application/json" }),
      body: opts.body === undefined ? null : JSON.stringify(opts.body),
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
    const json: unknown = await res.json().catch(() => undefined);
    if (!res.ok) {
      const err = ApiError.safeParse(json);
      throw new ReviewApiError(res.status, err.success ? err.data.error.code : "http_error",
        err.success ? err.data.error.message : `HTTP ${res.status}`);
    }
    return out.parse(json);
  }

  async createReview(req: z.input<typeof CreateReviewRequest>) {
    return this.#call(routes.createReview, ReviewResponse, { body: CreateReviewRequest.parse(req) });
  }
  async getReview(id: string) { return this.#call(routes.getReview, ReviewResponse, { id }); }
  async createIndex(req: z.input<typeof CreateIndexRequest>) {
    return this.#call(routes.createIndex, IndexResponse, { body: CreateIndexRequest.parse(req) });
  }
  async getIndex(id: string) { return this.#call(routes.getIndex, IndexResponse, { id }); }
  async createTestGen(req: z.input<typeof CreateTestGenRequest>) {
    return this.#call(routes.createTestGen, TestGenResponse, { body: CreateTestGenRequest.parse(req) });
  }
  async getTestGen(id: string) { return this.#call(routes.getTestGen, TestGenResponse, { id }); }
  async score(req: z.input<typeof ScoreRequest>) {
    return this.#call(routes.score, ScoreResponse, { body: ScoreRequest.parse(req) });
  }

  /** Stream review events (SSE). Ends after a "completed" or "error" event. */
  async *reviewEvents(id: string, signal?: AbortSignal): AsyncGenerator<ReviewEvent> {
    const res = await this.#fetch(this.#url(routes.reviewEvents, id), {
      headers: this.#headers({ accept: "text/event-stream" }),
      ...(signal ? { signal } : {}),
    });
    if (!res.ok || !res.body) throw new ReviewApiError(res.status, "sse_error", `HTTP ${res.status}`);
    for await (const data of parseSse(res.body)) {
      const ev = ReviewEvent.parse(JSON.parse(data));
      yield ev;
      if (ev.type === "completed" || ev.type === "error") return;
    }
  }
}

/** Minimal SSE parser: yields the joined `data:` payload of each event. */
export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true });
    let idx: number;
    while ((idx = buf.search(/\r?\n\r?\n/)) !== -1) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx).replace(/^\r?\n\r?\n/, "");
      const data = raw.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
      if (data) yield data;
    }
  }
}
