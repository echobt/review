import { test } from "vitest";
import assert from "node:assert/strict";
import { buildApp } from "../src/app.ts";

const sent: { q: string; tenant: string; payload: unknown }[] = [];
const app = buildApp({
  enqueue: async (q, tenant, payload) => { sent.push({ q, tenant, payload }); },
  authenticate: async (k) => (k === "good" ? "tenant-1" : undefined),
});
const auth = { authorization: "Bearer good" };

test("healthz is unauthenticated", async () => {
  assert.equal((await app.inject({ method: "GET", url: "/healthz" })).statusCode, 200);
});

test("rejects missing/invalid API key with 401", async () => {
  assert.equal((await app.inject({ method: "POST", url: "/v1/reviews", payload: {} })).statusCode, 401);
  assert.equal((await app.inject({ method: "POST", url: "/v1/reviews", headers: { authorization: "Bearer bad" }, payload: {} })).statusCode, 401);
});

test("invalid body returns 400 and enqueues nothing", async () => {
  const before = sent.length;
  const r = await app.inject({ method: "POST", url: "/v1/reviews", headers: auth, payload: { kind: "diff", repositoryId: "r", diff: "" } });
  assert.equal(r.statusCode, 400); assert.equal(sent.length, before);
});

test("valid diff review returns 201 and enqueues tenant-scoped review.requested", async () => {
  const r = await app.inject({ method: "POST", url: "/v1/reviews", headers: auth, payload: { kind: "diff", repositoryId: "repo", diff: "x" } });
  assert.equal(r.statusCode, 201);
  const last = sent.at(-1)!;
  assert.equal(last.q, "review.requested"); assert.equal(last.tenant, "tenant-1");
  assert.match((last.payload as { diffObjectKey: string }).diffObjectKey, /^tenants\/tenant-1\/diffs\//);
});
