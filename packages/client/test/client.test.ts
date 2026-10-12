import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { ReviewClient, ReviewApiError } from "../src/index.ts";

const review = { id: "r1", tenantId: "t1", repositoryId: "repo", status: "queued", findings: [], createdAt: "2026-10-11T00:00:00Z" };
const seen: { auth?: string | undefined; body?: string } = {};

const server = createServer(async (req: IncomingMessage, res) => {
  seen.auth = req.headers.authorization;
  let body = ""; for await (const c of req) body += c; seen.body = body;
  if (req.url === "/v1/reviews" && req.method === "POST") { res.writeHead(201, { "content-type": "application/json" }); return res.end(JSON.stringify(review)); }
  if (req.url === "/v1/reviews/bad") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ id: "x" })); }
  if (req.url === "/v1/reviews/r1/events") {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ type: "status", reviewId: "r1", status: "reviewing" })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: "completed", reviewId: "r1", review: { ...review, status: "completed" } })}\n\n`);
    return res.end();
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { code: "not_found", message: "nope" } }));
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => server.close());

const client = new ReviewClient({ baseUrl, apiKey: "test-key" });

test("createReview sends validated body with bearer auth and parses response", async () => {
  const r = await client.createReview({ kind: "diff", repositoryId: "repo", diff: "--- a\n+++ b\n" });
  assert.equal(r.id, "r1");
  assert.equal(seen.auth, "Bearer test-key");
  assert.equal(JSON.parse(seen.body!).kind, "diff");
});

test("invalid request is rejected client-side before any I/O", async () => {
  await assert.rejects(client.createReview({ kind: "diff", repositoryId: "repo", diff: "" }));
});

test("malformed server response fails schema validation", async () => {
  await assert.rejects(client.getReview("bad"), (e: Error) => e.name === "ZodError");
});

test("API errors map to ReviewApiError with code", async () => {
  await assert.rejects(client.getIndex("missing"), (e: unknown) => e instanceof ReviewApiError && e.status === 404 && e.code === "not_found");
});

test("reviewEvents streams SSE until completed", async () => {
  const types: string[] = [];
  for await (const ev of client.reviewEvents("r1")) types.push(ev.type);
  assert.deepEqual(types, ["status", "completed"]);
});
