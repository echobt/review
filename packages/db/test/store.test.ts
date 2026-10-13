import { beforeAll, expect, test } from "vitest";
import { addFeedback, authenticateApiKey, createIndexRecord, createReview, createTestGenRecord, getReview, getTenantConfig, getTestGenRecord,
  hashApiKey, insertFindings, latestReadyIndex, putTenantConfig, suppressedFingerprints, updateIndexRecord, updateReview, updateTestGenRecord,
  withTenant, type Database } from "../src/index.ts";
import { createTestDatabase } from "../src/testing.ts";
import type { PGliteLike } from "../src/db.ts";

let db: Database, owner: PGliteLike, t1: string, t2: string;
beforeAll(async () => { const h = await createTestDatabase(); db = h.db; owner = h.owner; t1 = await h.newTenant(); t2 = await h.newTenant(); });

const finding = (id: string, reviewId: string) => ({ id, reviewId, category: "bug" as const, severity: "high" as const, title: "t", body: "b",
  location: { path: "a.ts", startLine: 1, endLine: 2 }, related: [], confidence: 0.9, source: "llm" as const, cwe: [] });

test("review lifecycle with findings; other tenant cannot see it", async () => {
  const r = await withTenant(db, t1, (sql) => createReview(sql, t1, { repositoryId: "repo-1", diffObjectKey: "k" }));
  expect(r.status).toBe("queued");
  await withTenant(db, t1, async (sql) => {
    await insertFindings(sql, t1, [{ finding: finding("f1", r.id), fingerprint: "fp1" }]);
    await updateReview(sql, r.id, { status: "completed", summary: "s", usage: { inputTokens: 1, outputTokens: 2, costUsd: 0.01, latencyMs: 5 } });
  });
  const got = await withTenant(db, t1, (sql) => getReview(sql, r.id));
  expect([got!.status, got!.findings.length, got!.summary, typeof got!.completedAt]).toEqual(["completed", 1, "s", "string"]);
  expect(await withTenant(db, t2, (sql) => getReview(sql, r.id))).toBeUndefined();
});

test("negative feedback suppresses fingerprint per repository", async () => {
  const r = await withTenant(db, t1, (sql) => createReview(sql, t1, { repositoryId: "repo-2" }));
  await withTenant(db, t1, (sql) => insertFindings(sql, t1, [{ finding: finding("f2", r.id), fingerprint: "fp2" }, { finding: finding("f3", r.id), fingerprint: "fp3" }]));
  const fb = await withTenant(db, t1, (sql) => addFeedback(sql, t1, "f2", { verdict: "dismissed" }));
  await withTenant(db, t1, (sql) => addFeedback(sql, t1, "f3", { verdict: "thumbs_up" }));
  expect(fb!.verdict).toBe("dismissed");
  expect([...await withTenant(db, t1, (sql) => suppressedFingerprints(sql, "repo-2"))]).toEqual(["fp2"]);
  expect(await withTenant(db, t2, (sql) => addFeedback(sql, t2, "f2", { verdict: "dismissed" }))).toBeUndefined();
});

test("index records, test-gen records, tenant config, API key auth", async () => {
  const idx = await withTenant(db, t1, (sql) => createIndexRecord(sql, t1, { repositoryId: "repo-1", commitSha: "abc1234", embedModel: "m" }));
  await withTenant(db, t1, (sql) => updateIndexRecord(sql, idx.id, { status: "ready", fileCount: 3, languages: ["typescript"] }));
  expect((await withTenant(db, t1, (sql) => latestReadyIndex(sql, "repo-1")))!.fileCount).toBe(3);
  const tg = await withTenant(db, t1, (sql) => createTestGenRecord(sql, t1, { repositoryId: "repo-1", targetPaths: ["a.ts"] }));
  await withTenant(db, t1, (sql) => updateTestGenRecord(sql, tg.id, { status: "completed", attempts: 2, result: { testsKept: 1, testsDiscarded: 2 } }));
  expect((await withTenant(db, t1, (sql) => getTestGenRecord(sql, tg.id)))!.testsKept).toBe(1);
  expect((await withTenant(db, t1, (sql) => getTenantConfig(sql, t1))).maxComments).toBe(15);
  await withTenant(db, t1, async (sql) => putTenantConfig(sql, t1, { ...(await getTenantConfig(sql, t1)), maxComments: 3 }));
  expect((await withTenant(db, t1, (sql) => getTenantConfig(sql, t1))).maxComments).toBe(3);
  await owner.query("INSERT INTO api_keys (tenant_id, prefix, key_hash) VALUES ($1, 'rk_', $2)", [t2, hashApiKey("rk_secret")]);
  expect(await db.tx((sql) => authenticateApiKey(sql, "rk_secret"))).toBe(t2);
  expect(await db.tx((sql) => authenticateApiKey(sql, "nope"))).toBeUndefined();
});
