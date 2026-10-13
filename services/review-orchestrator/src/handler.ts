import type { Message } from "@review/core";
import type { ObjectStore } from "@review/service-common";
import { runReview, type OrchestratorDeps, type ReviewOutcome } from "./orchestrator.ts";

/** review.requested: load the diff (object store key, else GitHub PR diff) and run the review. */
export async function handle(deps: OrchestratorDeps & { store: ObjectStore }, msg: Message<"review.requested">): Promise<ReviewOutcome> {
  const p = msg.payload;
  let diff: string | undefined;
  if (p.diffObjectKey) diff = (await deps.store.get(p.diffObjectKey))?.toString("utf8");
  else if (p.pullRequest && deps.github) diff = await deps.github.getPullRequestDiff(p.pullRequest);
  if (diff === undefined) throw new Error(`review ${p.reviewId}: no diff available`);
  return runReview(deps, { tenantId: msg.tenantId, reviewId: p.reviewId, repositoryId: p.repositoryId, diff, ...(p.pullRequest ? { pullRequest: p.pullRequest } : {}) });
}
