import { readFileSync } from "node:fs";
import { ReviewClient, type ClientOptions } from "@review/client";
import type { PullRequestRef, Review, RepoIndex, TestGenRun, ScoreReport, ReviewEvent } from "@review/core";

export { ReviewClient, ReviewApiError } from "@review/client";
export type * from "@review/core";

export interface SdkOptions extends Partial<ClientOptions> {
  /** Called for every streamed review event (status, finding, ...). */
  onEvent?: (ev: ReviewEvent) => void;
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

  constructor(opts: SdkOptions = {}, env: NodeJS.ProcessEnv = process.env) {
    const baseUrl = opts.baseUrl ?? env.REVIEW_API_URL;
    if (!baseUrl) throw new Error("baseUrl missing: pass { baseUrl } or set REVIEW_API_URL");
    const apiKey = resolveApiKey(env, opts.apiKey);
    this.client = new ReviewClient({ ...opts, baseUrl, ...(apiKey ? { apiKey } : {}) });
    this.#onEvent = opts.onEvent;
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

  scoreReview(reviewId: string, datasetCaseId: string): Promise<ScoreReport> {
    return this.client.score({ reviewId, datasetCaseId });
  }
}
