import { test } from "vitest";
import assert from "node:assert/strict";
import { ReviewClient, ReviewApiError } from "../src/index.ts";

const review = { id: "r1", tenantId: "t1", repositoryId: "repo", status: "queued", findings: [], createdAt: "2026-10-11T00:00:00Z" };
const finding = { id: "f1", reviewId: "r1", category: "bug", severity: "high", title: "t", body: "b", location: { path: "a.ts", startLine: 1, endLine: 2 },
  related: [], confidence: 0.9, source: "llm", cwe: [] };
const index = { id: "i1", tenantId: "t1", repositoryId: "repo", commitSha: "abcdef1", status: "pending", languages: [], fileCount: 0, symbolCount: 0, chunkCount: 0, embeddingModel: "m" };
const job = { id: "s1", reviewId: "r1", datasetCaseId: "c1", status: "queued" };

type Call = { method: string; url: string; body?: string | null; headers: Record<string, string> };
function fake(handler: (c: Call, n: number) => Response) {
  const calls: Call[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const c = { method: init?.method ?? "GET", url: String(url), body: init?.body as string | null, headers: (init?.headers ?? {}) as Record<string, string> };
    calls.push(c);
    return handler(c, calls.length);
  }) as typeof fetch;
  return { f, calls };
}
const sleeps: number[] = [];
const opts = { baseUrl: "http://api.test", apiKey: "k", sleep: async (ms: number) => { sleeps.push(ms); }, random: () => 0.5 };

test("every core route is wired with the right method/path and validated output", async () => {
  const { f, calls } = fake((c) => {
    const p = new URL(c.url).pathname;
    if (p === "/v1/reviews" || p === "/v1/reviews/r1") return Response.json(review);
    if (p === "/v1/reviews/r1/findings") return Response.json({ findings: [finding] });
    if (p === "/v1/findings/f1/feedback") return Response.json({ id: "fb", findingId: "f1", verdict: "resolved", createdAt: "2026-10-11T00:00:00Z" });
    if (p === "/v1/config") return Response.json(JSON.parse(c.body ?? "{}"));
    if (p.startsWith("/v1/indexes")) return Response.json(index);
    if (p.startsWith("/v1/testgen")) return Response.json({ id: "g1", tenantId: "t1", repositoryId: "repo", status: "queued", targetPaths: ["a.ts"], attempts: 0, createdAt: "2026-10-11T00:00:00Z" });
    if (p.startsWith("/v1/scores")) return Response.json(job);
    return Response.json({ error: { code: "not_found", message: p } }, { status: 404 });
  });
  const c = new ReviewClient({ ...opts, fetch: f });
  await c.createReview({ kind: "diff", repositoryId: "repo", diff: "x" });
  await c.getReview("r1");
  assert.equal((await c.listFindings("r1"))[0]!.id, "f1");
  assert.equal((await c.createFeedback("f1", { verdict: "resolved" })).verdict, "resolved");
  assert.equal((await c.getConfig()).maxComments, 15);
  assert.equal((await c.putConfig({ maxComments: 3 })).maxComments, 3);
  await c.createIndex({ repositoryId: "repo", commitSha: "abcdef1" });
  await c.getIndex("i1");
  await c.createTestGen({ repositoryId: "repo", targetPaths: ["a.ts"] });
  await c.getTestGen("g1");
  assert.equal((await c.score({ reviewId: "r1", datasetCaseId: "c1" })).status, "queued");
  assert.equal((await c.getScore("s1")).id, "s1");
  assert.deepEqual(calls.map((x) => `${x.method} ${new URL(x.url).pathname}`), [
    "POST /v1/reviews", "GET /v1/reviews/r1", "GET /v1/reviews/r1/findings", "POST /v1/findings/f1/feedback", "GET /v1/config", "PUT /v1/config",
    "POST /v1/indexes", "GET /v1/indexes/i1", "POST /v1/testgen", "GET /v1/testgen/g1", "POST /v1/scores", "GET /v1/scores/s1"]);
  assert.ok(calls.every((x) => x.headers.authorization === "Bearer k"));
});

test("GET retries 503 with jittered backoff then succeeds", async () => {
  sleeps.length = 0;
  const { f, calls } = fake((_c, n) => (n < 3 ? new Response("busy", { status: 503 }) : Response.json(review)));
  const r = await new ReviewClient({ ...opts, fetch: f }).getReview("r1");
  assert.equal(r.id, "r1"); assert.equal(calls.length, 3);
  assert.deepEqual(sleeps, [100, 200]);
});

test("GET gives up after maxRetries and surfaces the error", async () => {
  const { f, calls } = fake(() => Response.json({ error: { code: "unavailable", message: "x" } }, { status: 503 }));
  await assert.rejects(new ReviewClient({ ...opts, fetch: f, maxRetries: 2 }).getScore("s1"), (e: unknown) => e instanceof ReviewApiError && e.code === "unavailable");
  assert.equal(calls.length, 3);
});

test("POST is never retried", async () => {
  const { f, calls } = fake(() => new Response("busy", { status: 503 }));
  await assert.rejects(new ReviewClient({ ...opts, fetch: f }).score({ reviewId: "r1", datasetCaseId: "c1" }), (e: unknown) => e instanceof ReviewApiError && e.status === 503);
  assert.equal(calls.length, 1);
});

test("SSE resumes once with Last-Event-ID after a dropped stream", async () => {
  const enc = new TextEncoder();
  const ev = (id: string, e: object) => `id: ${id}\ndata: ${JSON.stringify(e)}\n\n`;
  const { f, calls } = fake((_c, n) => {
    if (n === 1) {
      const body = new ReadableStream<Uint8Array>({
        start(ctl) { ctl.enqueue(enc.encode(ev("1", { type: "status", reviewId: "r1", status: "reviewing" }))); },
        pull(ctl) { ctl.error(new Error("socket hang up")); },
      });
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    }
    return new Response(ev("2", { type: "finding", reviewId: "r1", finding }) + ev("3", { type: "completed", reviewId: "r1", review: { ...review, status: "completed" } }));
  });
  const types: string[] = [];
  for await (const e of new ReviewClient({ ...opts, fetch: f }).reviewEvents("r1")) types.push(e.type);
  assert.deepEqual(types, ["status", "finding", "completed"]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.headers["last-event-id"], undefined);
  assert.equal(calls[1]!.headers["last-event-id"], "1");
});

test("SSE gives up after one reconnect", async () => {
  const { f, calls } = fake(() => new Response(`id: 1\ndata: ${JSON.stringify({ type: "status", reviewId: "r1", status: "reviewing" })}\n\n`));
  const it = new ReviewClient({ ...opts, fetch: f }).reviewEvents("r1");
  const drain = async () => { while (!(await it.next()).done); };
  await assert.rejects(drain(), (e: unknown) => e instanceof ReviewApiError && e.code === "sse_dropped");
  assert.equal(calls.length, 2);
});
