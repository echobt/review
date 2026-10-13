import { readFileSync } from "node:fs";
import { createHmac, timingSafeEqual } from "node:crypto";
import { ReviewClient, type ClientOptions } from "@review/client";
import type { PullRequestRef, Review, RepoIndex, TestGenRun, ScoreReport, ReviewEvent } from "@review/core";

export { ReviewClient, ReviewApiError } from "@review/client";
export type * from "@review/core";

export interface SdkOptions extends Partial<ClientOptions> {
  /** Called for every streamed review event (status, finding, ...). */
  onEvent?: (ev: ReviewEvent) => void;
  /** scoreReview polling: total timeout (default 120s) and injectable sleep. */
  scoreTimeoutMs?: number;
}

/**
 * Verify an `X-Signature-256: sha256=<hex>` style header over the exact raw request body (HMAC-SHA256,
 * constant-time compare). Accepts the bare hex digest too.
 */
export function verifyWebhookSignature(secret: string, rawBody: string | Uint8Array, header: string | null | undefined): boolean {
  if (!secret || !header) return false;
  const got = Buffer.from(header.trim().replace(/^sha256=/, ""), "hex");
  const want = createHmac("sha256", secret).update(rawBody).digest();
  return got.length === want.length && timingSafeEqual(got, want);
}

/**
 * Resolve the API key: explicit option > REVIEW_API_KEY > file at REVIEW_API_KEY_FILE.
 * The key is never logged or included in error messages.
 */
export function resolveApiKey(env: NodeJS.ProcessEnv = process.env, explicit?: string): string | undefined {
  if (explicit) return explicit;
  if (env.REVIEW_API_KEY) return env.REVIEW_API_KEY;
  if (env.REVIEW_API_KEY_FILE) return readFileSync(env.REVIEW_API_KEY_FILE, "utf8").trim() || undefined;
  return undefined;
}

export class ReviewSdk {
  readonly client: ReviewClient;
  readonly #onEvent: ((ev: ReviewEvent) => void) | undefined;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #scoreTimeoutMs: number;

  constructor(opts: SdkOptions = {}, env: NodeJS.ProcessEnv = process.env) {
    const baseUrl = opts.baseUrl ?? env.REVIEW_API_URL;
    if (!baseUrl) throw new Error("baseUrl missing: pass { baseUrl } or set REVIEW_API_URL");
    const apiKey = resolveApiKey(env, opts.apiKey);
    this.client = new ReviewClient({ ...opts, baseUrl, ...(apiKey ? { apiKey } : {}) });
    this.#onEvent = opts.onEvent;
    this.#sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.#scoreTimeoutMs = opts.scoreTimeoutMs ?? 120_000;
  }

  /** Start a review and resolve with the completed review (streams events via onEvent). */
  async #runReview(start: Promise<Review>): Promise<Review> {
    const created = await start;
    if (created.status === "completed" || created.status === "failed") return created;
    for await (const ev of this.client.reviewEvents(created.id)) {
      this.#onEvent?.(ev);
      if (ev.type === "completed") return ev.review;
      if (ev.type === "error") throw new Error(`review ${created.id} failed: ${ev.message}`);
    }
    return this.client.getReview(created.id);
  }

  reviewPullRequest(repositoryId: string, pullRequest: PullRequestRef): Promise<Review> {
    return this.#runReview(this.client.createReview({ kind: "pull_request", repositoryId, pullRequest }));
  }

  reviewDiff(repositoryId: string, diff: string, baseSha?: string): Promise<Review> {
    return this.#runReview(this.client.createReview({ kind: "diff", repositoryId, diff, ...(baseSha ? { baseSha } : {}) }));
  }

  indexRepo(repositoryId: string, commitSha: string, incremental = true): Promise<RepoIndex> {
    return this.client.createIndex({ repositoryId, commitSha, incremental });
  }

  generateTests(repositoryId: string, targetPaths: string[], opts: { reviewId?: string; maxIterations?: number } = {}): Promise<TestGenRun> {
    return this.client.createTestGen({ repositoryId, targetPaths, ...opts });
  }

  /** Enqueue scoring and poll until the report is ready (backoff 250ms doubling to 5s, bounded by scoreTimeoutMs). */
  async scoreReview(reviewId: string, datasetCaseId: string): Promise<ScoreReport> {
    let job = await this.client.score({ reviewId, datasetCaseId });
    let waited = 0;
    for (let delay = 250; job.status === "queued"; delay = Math.min(delay * 2, 5_000)) {
      if (waited >= this.#scoreTimeoutMs) throw new Error(`score ${job.id} not completed after ${this.#scoreTimeoutMs}ms`);
      await this.#sleep(delay);
      waited += delay;
      job = await this.client.getScore(job.id);
    }
    if (job.status === "failed" || !job.report) throw new Error(`score ${job.id} failed: ${job.error ?? "no report"}`);
    return job.report;
  }
}
