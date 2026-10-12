import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMessage, QUEUE_NAMES, CreateReviewRequest, ReviewEvent } from "../src/index.ts";

const env = { messageId: "7f1d2c9e-8a8b-4c4e-9d55-1d0f3b9a2c11", tenantId: "t1", createdAt: "2026-10-11T00:00:00Z" };

test("parseMessage accepts a valid sandbox.run and defaults network to none", () => {
  const m = parseMessage("sandbox.run", { ...env, payload: { runId: "r", image: "node:24", command: ["npm", "test"], workspaceObjectKey: "t1/w", timeoutSec: 60 } });
  assert.equal(m.payload.network, "none");
  assert.equal(m.attempt, 0);
});

test("parseMessage rejects missing tenant and over-long sandbox timeout", () => {
  assert.throws(() => parseMessage("score.requested", { ...env, tenantId: "", payload: { reviewId: "r", datasetCaseId: "c", rubricVersion: "1.0.0" } }));
  assert.throws(() => parseMessage("sandbox.run", { ...env, payload: { runId: "r", image: "i", command: ["x"], workspaceObjectKey: "k", timeoutSec: 99999 } }));
});

test("all documented queues exist", () => {
  for (const q of ["index.requested", "review.requested", "agent.task", "sandbox.run", "score.requested", "finding.created", "review.completed"]) {
    assert.ok(QUEUE_NAMES.includes(q as never), q);
  }
});

test("CreateReviewRequest discriminates diff vs pull_request", () => {
  assert.equal(CreateReviewRequest.safeParse({ kind: "diff", repositoryId: "r", diff: "" }).success, false);
  assert.equal(CreateReviewRequest.safeParse({ kind: "pull_request", repositoryId: "r", pullRequest: { provider: "github", owner: "o", repo: "r", number: 1 } }).success, true);
});

test("ReviewEvent rejects unknown type", () => {
  assert.equal(ReviewEvent.safeParse({ type: "nope", reviewId: "r" }).success, false);
});
