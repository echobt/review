import { test, expect, beforeAll } from "vitest";
import { createHmac, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { Finding } from "@review/core";
import { createTestDatabase } from "@review/db/testing";
import { insertFindings, updateReview, withTenant, type Database } from "@review/db";
import { memoryObjectStore } from "@review/service-common";
import { buildApp, prReviewId } from "../src/app.ts";

const SECRET = "whsec";
const sent: { q: string; tenant: string; payload: Record<string, unknown>; jobId?: string }[] = [];
let db: Database, tenantId: string, app: ReturnType<typeof buildApp>;
const store = memoryObjectStore();
const auth = { authorization: "Bearer k" };

beforeAll(async () => {
  const t = await createTestDatabase();
  db = t.db; tenantId = await t.newTenant();
  app = buildApp({
    enqueue: async (q, tenant, payload, opts) => { sent.push({ q, tenant, payload: payload as Record<string, unknown>, ...(opts?.jobId ? { jobId: opts.jobId } : {}) }); },
    authenticate: async (k) => (k === "k" ? tenantId : undefined),
    db, store, events: new EventEmitter(), webhookSecret: () => SECRET,
    resolveInstallation: async (iid) => (iid === "42" ? tenantId : undefined),
  });
});

const hook = (event: string, body: unknown, sig?: string | null) => {
  const payload = JSON.stringify(body);
  const s = sig === undefined ? "sha256=" + createHmac("sha256", SECRET).update(payload).digest("hex") : sig;
  return app.inject({ method: "POST", url: "/webhooks/github", payload, headers: { "content-type": "application/json", "x-github-event": event, ...(s ? { "x-hub-signature-256": s } : {}) } });
};
const prEvent = { action: "opened", installation: { id: 42 }, repository: { full_name: "o/r", name: "r", owner: { login: "o" } }, pull_request: { number: 7, head: { sha: "abcdef1" } } };

test("webhook signature: valid ping 200, invalid/missing 401", async () => {
  expect((await hook("ping", { zen: "x" })).statusCode).toBe(200);
  expect((await hook("ping", { zen: "x" }, "sha256=" + "0".repeat(64))).statusCode).toBe(401);
  expect((await hook("ping", { zen: "x" }, null)).statusCode).toBe(401);
});

test("push webhook enqueues an incremental index for the branch (standing index update); tags/deletes ignored", async () => {
  const after = "c".repeat(40);
  const push = { ref: "refs/heads/main", after, installation: { id: 42 }, repository: { full_name: "o/r" } };
  const n = sent.length;
  const r = await hook("push", push);
  expect(r.statusCode).toBe(202);
  expect(sent.slice(n)).toEqual([{ q: "index.requested", tenant: tenantId, payload: { indexId: r.json().indexId, repositoryId: "github:o/r", commitSha: after, mode: "incremental", branch: "main" }, jobId: `index-${r.json().indexId}` }]);
  expect((await hook("push", { ...push, ref: "refs/tags/v1" })).json()).toEqual({ ignored: "push" });
  expect((await hook("push", { ...push, deleted: true })).json()).toEqual({ ignored: "push" });
  expect((await hook("push", { ...push, installation: { id: 9 } })).statusCode).toBe(404);
  expect(sent).toHaveLength(n + 1);
});

test("pull_request opened creates review and enqueues with deterministic jobId; redelivery is idempotent", async () => {
  const r = await hook("pull_request", prEvent);
  expect(r.statusCode).toBe(202);
  const rid = prReviewId("o/r", 7, "abcdef1");
  expect(r.json()).toEqual({ reviewId: rid });
  expect(sent.at(-1)).toMatchObject({ q: "review.requested", tenant: tenantId, jobId: rid, payload: { reviewId: rid, pullRequest: { owner: "o", repo: "r", number: 7, headSha: "abcdef1" } } });
  expect((await hook("pull_request", prEvent)).statusCode).toBe(202);
  const g = await app.inject({ method: "GET", url: `/v1/reviews/${rid}`, headers: auth });
  expect(g.json()).toMatchObject({ id: rid, status: "queued" });
  expect((await hook("pull_request", { ...prEvent, installation: { id: 9 } })).statusCode).toBe(404);
});

test("diff review writes diff to object store; findings, feedback, SSE for completed review", async () => {
  const r = await app.inject({ method: "POST", url: "/v1/reviews", headers: auth, payload: { kind: "diff", repositoryId: "repo", diff: "+x" } });
  expect(r.statusCode).toBe(201);
  const rid = r.json().id as string;
  const key = sent.at(-1)!.payload.diffObjectKey as string;
  expect(key).toBe(`tenants/${tenantId}/diffs/${rid}.patch`);
  expect((await store.get(key))!.toString()).toBe("+x");

  const finding = Finding.parse({ id: randomUUID(), reviewId: rid, category: "bug", severity: "high", title: "t", body: "b", confidence: 0.9, source: "llm", location: { path: "a.ts", startLine: 1, endLine: 1 } });
  await withTenant(db, tenantId, async (sql) => { await insertFindings(sql, tenantId, [{ finding, fingerprint: "fp" }]); await updateReview(sql, rid, { status: "completed", summary: "s" }); });
  expect((await app.inject({ method: "GET", url: `/v1/reviews/${rid}/findings`, headers: auth })).json().findings).toHaveLength(1);

  const fb = await app.inject({ method: "POST", url: `/v1/findings/${finding.id}/feedback`, headers: auth, payload: { verdict: "dismissed" } });
  expect(fb.statusCode).toBe(201);
  expect(fb.json()).toMatchObject({ findingId: finding.id, verdict: "dismissed" });
  expect((await app.inject({ method: "POST", url: `/v1/findings/${finding.id}/feedback`, headers: auth, payload: { verdict: "nope" } })).statusCode).toBe(400);
  expect((await app.inject({ method: "POST", url: `/v1/findings/missing/feedback`, headers: auth, payload: { verdict: "resolved" } })).statusCode).toBe(404);

  const sse = await app.inject({ method: "GET", url: `/v1/reviews/${rid}/events`, headers: auth });
  expect(sse.headers["content-type"]).toBe("text/event-stream");
  expect(sse.body).toMatch(/^event: completed\ndata: /);
  expect(JSON.parse(sse.body.split("data: ")[1]!).review.summary).toBe("s");
});

test("config GET/PUT with validation", async () => {
  expect((await app.inject({ method: "GET", url: "/v1/config", headers: auth })).json()).toMatchObject({ confidenceThreshold: 0.6, maxComments: 15 });
  expect((await app.inject({ method: "PUT", url: "/v1/config", headers: auth, payload: { maxComments: 999 } })).statusCode).toBe(400);
  expect((await app.inject({ method: "PUT", url: "/v1/config", headers: auth, payload: { maxComments: 5 } })).statusCode).toBe(200);
  expect((await app.inject({ method: "GET", url: "/v1/config", headers: auth })).json().maxComments).toBe(5);
});

test("scores 202 + GET; testgen persists and enqueues agent.task", async () => {
  const s = await app.inject({ method: "POST", url: "/v1/scores", headers: auth, payload: { reviewId: "r", datasetCaseId: "c1" } });
  expect(s.statusCode).toBe(202);
  expect(s.json()).toMatchObject({ status: "queued", datasetCaseId: "c1" });
  expect(sent.at(-1)).toMatchObject({ q: "score.requested", payload: { scoreId: s.json().id } });
  expect((await app.inject({ method: "GET", url: `/v1/scores/${s.json().id}`, headers: auth })).json().status).toBe("queued");

  const t = await app.inject({ method: "POST", url: "/v1/testgen", headers: auth, payload: { repositoryId: "repo", targetPaths: ["src/a.ts"] } });
  expect(t.statusCode).toBe(202);
  const last = sent.at(-1)!;
  expect(last).toMatchObject({ q: "agent.task", payload: { agent: "test-gen", agentTaskId: t.json().id } });
  expect(await store.get(last.payload.contextObjectKey as string)).toBeDefined();
  expect((await app.inject({ method: "GET", url: `/v1/testgen/${t.json().id}`, headers: auth })).json().status).toBe("queued");
});
