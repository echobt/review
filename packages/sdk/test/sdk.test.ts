import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReviewSdk, resolveApiKey } from "../src/index.ts";

test("resolveApiKey precedence: explicit > env > file", () => {
  const dir = mkdtempSync(join(tmpdir(), "sdk-"));
  const f = join(dir, "key"); writeFileSync(f, "from-file\n");
  assert.equal(resolveApiKey({ REVIEW_API_KEY_FILE: f }), "from-file");
  assert.equal(resolveApiKey({ REVIEW_API_KEY: "env", REVIEW_API_KEY_FILE: f }), "env");
  assert.equal(resolveApiKey({ REVIEW_API_KEY: "env" }, "explicit"), "explicit");
  assert.equal(resolveApiKey({}), undefined);
});

test("constructor requires a base URL", () => {
  assert.throws(() => new ReviewSdk({}, {}), /baseUrl missing/);
});

test("reviewDiff streams events and returns the completed review", async () => {
  const review = { id: "r1", tenantId: "t", repositoryId: "repo", status: "queued", findings: [], createdAt: "2026-10-11T00:00:00Z" };
  const done = { ...review, status: "completed" };
  const sse = [{ type: "status", reviewId: "r1", status: "reviewing" }, { type: "completed", reviewId: "r1", review: done }]
    .map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
  const calls: string[] = [];
  const fakeFetch = (async (url: string | URL | Request) => {
    const u = String(url); calls.push(u);
    if (u.endsWith("/events")) return new Response(sse, { headers: { "content-type": "text/event-stream" } });
    return Response.json(review, { status: 201 });
  }) as typeof fetch;
  const events: string[] = [];
  const sdk = new ReviewSdk({ baseUrl: "http://api.test", fetch: fakeFetch, onEvent: (e) => events.push(e.type) }, {});
  const r = await sdk.reviewDiff("repo", "diff --git a/x b/x");
  assert.equal(r.status, "completed");
  assert.deepEqual(events, ["status", "completed"]);
  assert.deepEqual(calls, ["http://api.test/v1/reviews", "http://api.test/v1/reviews/r1/events"]);
});
