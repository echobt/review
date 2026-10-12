import { z } from "zod";
import { PullRequestRef, Review, RepoIndex, TestGenRun, ScoreReport, Finding } from "./schemas.ts";

// Public REST API v1 request/response contracts (api-gateway <-> @review/client).

export const CreateReviewRequest = z.union([
  z.object({ kind: z.literal("pull_request"), repositoryId: z.string(), pullRequest: PullRequestRef }),
  z.object({
    kind: z.literal("diff"),
    repositoryId: z.string(),
    /** Unified diff text. Capped to keep a single request bounded. */
    diff: z.string().min(1).max(2_000_000),
    baseSha: z.string().optional(),
  }),
]);
export type CreateReviewRequest = z.infer<typeof CreateReviewRequest>;

export const CreateIndexRequest = z.object({
  repositoryId: z.string(),
  commitSha: z.string().regex(/^[0-9a-f]{7,64}$/),
  /** Incremental build from the latest ready index when true. */
  incremental: z.boolean().default(true),
});
export type CreateIndexRequest = z.infer<typeof CreateIndexRequest>;

export const CreateTestGenRequest = z.object({
  repositoryId: z.string(),
  reviewId: z.string().optional(),
  targetPaths: z.array(z.string()).min(1).max(200),
  maxIterations: z.number().int().min(1).max(10).default(3),
});
export type CreateTestGenRequest = z.infer<typeof CreateTestGenRequest>;

export const ScoreRequest = z.object({
  reviewId: z.string(),
  /** Labelled dataset case id from the public scoring dataset. */
  datasetCaseId: z.string(),
});
export type ScoreRequest = z.infer<typeof ScoreRequest>;

export const ApiError = z.object({ error: z.object({ code: z.string(), message: z.string() }) });
export type ApiError = z.infer<typeof ApiError>;

/** Server-sent events emitted on GET /v1/reviews/:id/events. */
export const ReviewEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("status"), reviewId: z.string(), status: Review.shape.status }),
  z.object({ type: z.literal("finding"), reviewId: z.string(), finding: Finding }),
  z.object({ type: z.literal("completed"), reviewId: z.string(), review: Review }),
  z.object({ type: z.literal("error"), reviewId: z.string(), message: z.string() }),
]);
export type ReviewEvent = z.infer<typeof ReviewEvent>;

export { Review as ReviewResponse, RepoIndex as IndexResponse, TestGenRun as TestGenResponse, ScoreReport as ScoreResponse };

/** Route table shared by gateway and client so paths cannot drift. */
export const routes = {
  createReview: { method: "POST", path: "/v1/reviews" },
  getReview: { method: "GET", path: "/v1/reviews/:id" },
  reviewEvents: { method: "GET", path: "/v1/reviews/:id/events" },
  createIndex: { method: "POST", path: "/v1/indexes" },
  getIndex: { method: "GET", path: "/v1/indexes/:id" },
  createTestGen: { method: "POST", path: "/v1/testgen" },
  getTestGen: { method: "GET", path: "/v1/testgen/:id" },
  score: { method: "POST", path: "/v1/scores" },
  health: { method: "GET", path: "/healthz" },
} as const;
