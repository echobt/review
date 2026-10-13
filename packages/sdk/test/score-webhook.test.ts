import { test } from "vitest";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { ReviewSdk, verifyWebhookSignature } from "../src/index.ts";

const report = { id: "s1", rubricVersion: "1.0.0", datasetVersion: "sample-0.1", system: { name: "x", version: "1" }, score: 42, runs: 1, scoreStdDev: 0,
  createdAt: "2026-10-11T00:00:00Z", metrics: { precision: 1, recall: 0.5, f1: 0.66, severityWeightedRecall: 0.5, falsePositivesPerPr: 0, latencyP50Ms: 0, latencyP95Ms: 0, costPerPrUsd: 0 } };
const queued = { id: "s1", reviewId: "r1", datasetCaseId: "c1", status: "queued" };

function sdkWith(statuses: object[], extra: { scoreTimeoutMs?: number } = {}) {
  const calls: string[] = [], sleeps: number[] = [];
  let n = 0;
  const fetch = (async (u: string | URL | Request, init?: RequestInit) => {
    calls.push(`${init?.method} ${new URL(String(u)).pathname}`);
    return Response.json(statuses[Math.min(n++, statuses.length - 1)]);
  }) as typeof globalThis.fetch;
  const sdk = new ReviewSdk({ baseUrl: "http://api.test", fetch, sleep: async (ms) => { sleeps.push(ms); }, ...extra }, {});
  return { sdk, calls, sleeps };
}

test("scoreReview polls getScore with backoff until completed", async () => {
  const { sdk, calls, sleeps } = sdkWith([queued, queued, queued, { ...queued, status: "completed", report }]);
  assert.equal((await sdk.scoreReview("r1", "c1")).score, 42);
  assert.deepEqual(calls, ["POST /v1/scores", "GET /v1/scores/s1", "GET /v1/scores/s1", "GET /v1/scores/s1"]);
  assert.deepEqual(sleeps, [250, 500, 1000]);
});

test("scoreReview surfaces failed jobs and times out", async () => {
  await assert.rejects(sdkWith([queued, { ...queued, status: "failed", error: "unknown case" }]).sdk.scoreReview("r1", "c1"), /unknown case/);
  const t = sdkWith([queued], { scoreTimeoutMs: 1000 });
  await assert.rejects(t.sdk.scoreReview("r1", "c1"), /not completed/);
  assert.deepEqual(t.sleeps, [250, 500, 1000]);
});

test("verifyWebhookSignature accepts the right HMAC only", () => {
  const body = '{"action":"opened"}';
  const sig = `sha256=${createHmac("sha256", "s3cret").update(body).digest("hex")}`;
  assert.equal(verifyWebhookSignature("s3cret", body, sig), true);
  assert.equal(verifyWebhookSignature("s3cret", Buffer.from(body), sig.slice(7)), true);
  assert.equal(verifyWebhookSignature("wrong", body, sig), false);
  assert.equal(verifyWebhookSignature("s3cret", `${body} `, sig), false);
  assert.equal(verifyWebhookSignature("s3cret", body, "sha256=abc"), false);
  assert.equal(verifyWebhookSignature("s3cret", body, undefined), false);
});
