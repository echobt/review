import { afterAll, beforeAll, expect, test } from "vitest";
import { EnvelopeCipher, LocalKms } from "@review/crypto";
import { branchHead, createIndexRecord, getIndexRecord, invalidateBranchHead, readyIndexForCommit, withTenant } from "@review/db";
import { createTestDatabase } from "@review/db/testing";
import { defaultPolicy, HashEmbeddingProvider, MemoryBudgetLedger, ModelRouter, RoutingPolicy, type EmbedRequest } from "@review/models";
import { tenantKey } from "@review/queue";
import { memoryObjectStore } from "@review/service-common";
import { makeHandler } from "../src/handler.ts";
import { memoryRepoSource } from "../src/indexer.ts";
import { retrieve } from "../src/retrieval.ts";

const files = {
  "src/billing.ts": "export function computeInvoiceTotal(items: number[]) {\n  return applyDiscount(sum(items));\n}\n\nexport function applyDiscount(total: number) {\n  return total * 0.9;\n}\n",
  "src/math.ts": "export function sum(xs: number[]) {\n  return xs.reduce((a, b) => a + b, 0);\n}\n",
  "app/user.py": "class UserRepo:\n    def find_user(self, uid):\n        return load_row(uid)\n\n\ndef load_row(uid):\n    return uid\n",
  "node_modules/x/index.js": "function ignored() {}\n",
};
const C1 = "a".repeat(40), C2 = "b".repeat(40);
const source = memoryRepoSource({ [C1]: files, [C2]: { ...files, "src/math.ts": "export function sum(xs: number[]) {\n  let t = 0;\n  for (const x of xs) t += x;\n  return t;\n}\n" } });

class CountingEmbedder extends HashEmbeddingProvider {
  inputs: string[] = [];
  override async embed(req: EmbedRequest) { this.inputs.push(...req.input); return super.embed(req); }
}
const emb = new CountingEmbedder("local");
const router = new ModelRouter(RoutingPolicy.parse({ ...defaultPolicy, embed: [{ provider: "local", model: "hash", inputUsdPerMTok: 0, outputUsdPerMTok: 0, dimensions: 1024 }] }),
  { providers: [emb], budget: new MemoryBudgetLedger({ prUsd: 1, tenantMonthlyUsd: 1 }) });
const store = memoryObjectStore();
const cipher = new EnvelopeCipher(new LocalKms());
let t: Awaited<ReturnType<typeof createTestDatabase>>;
let tenantId: string, repoId: string;
const msg = (commitSha: string, mode: "full" | "incremental", indexId: string) => ({
  messageId: crypto.randomUUID(), tenantId, createdAt: new Date().toISOString(), attempt: 0,
  payload: { indexId, repositoryId: repoId, commitSha, mode },
});

beforeAll(async () => {
  t = await createTestDatabase();
  tenantId = await t.newTenant();
  repoId = (await t.owner.query<{ id: string }>("INSERT INTO repositories (tenant_id, provider, full_name) VALUES ($1, 'github', 'o/r') RETURNING id", [tenantId])).rows[0]!.id;
});
afterAll(() => t.db.close());

test("full then incremental index, retrieval, encrypted blobs", async () => {
  const handle = makeHandler({ db: t.db, store, cipher, router, source });

  const full = await handle(msg(C1, "full", "idx-1"));
  expect(full).toMatchObject({ files: 3, parsed: 3, reused: 0 });
  const fullEmbeds = emb.inputs.length;
  expect(fullEmbeds).toBe(full.chunks);
  expect(full.embedded).toBe(full.chunks);

  const rec = await withTenant(t.db, tenantId, (sql) => sql.query<{ status: string; file_count: number; symbol_count: number; chunk_count: number; languages: string[] }>("SELECT * FROM repo_indexes WHERE id = 'idx-1'"));
  expect(rec.rows[0]).toMatchObject({ status: "ready", file_count: 3, symbol_count: 6, chunk_count: full.chunks });
  expect([...rec.rows[0]!.languages].sort()).toEqual(["python", "typescript"]);

  emb.inputs = [];
  source.reads.length = 0;
  const inc = await handle(msg(C2, "incremental", "idx-2"));
  expect(inc).toMatchObject({ files: 3, parsed: 1, reused: 2, symbols: 6, chunks: full.chunks });
  expect(source.reads).toHaveLength(1);
  expect(emb.inputs.length).toBe(1);
  expect(emb.inputs[0]).toContain("file: src/math.ts");

  const rows = await withTenant(t.db, tenantId, (sql) => sql.query<{ path: string; content_hash: string; base: string | null }>(
    `SELECT c.path, c.content_hash, (SELECT b.id FROM chunks b WHERE b.index_id = 'idx-1' AND b.path = c.path AND b.content_hash = c.content_hash LIMIT 1) base FROM chunks c WHERE c.index_id = 'idx-2'`));
  for (const r of rows.rows) expect(r.base === null).toBe(r.path === "src/math.ts");
  const parent = await withTenant(t.db, tenantId, (sql) => sql.query<{ b: string }>("SELECT base_index_id b FROM repo_indexes WHERE id = 'idx-2'"));
  expect(parent.rows[0]!.b).toBe("idx-1");
  // reused edges keep resolved symbol ids in the new index
  const edges = await withTenant(t.db, tenantId, (sql) => sql.query<{ n: number }>(
    "SELECT count(*)::int n FROM symbol_edges e JOIN symbols s ON s.id = e.src_symbol_id WHERE e.index_id = 'idx-2' AND s.index_id = 'idx-2' AND e.dst_name = 'applyDiscount'"));
  expect(edges.rows[0]!.n).toBe(1);

  const q = "compute invoice total";
  const qv = (await router.embed([q], { scope: { tenantId } })).vectors[0]!;
  const hits = await withTenant(t.db, tenantId, (sql) => retrieve(sql, { indexId: "idx-2", query: q, queryVector: qv, seedSymbols: ["computeInvoiceTotal"], k: 5 }));
  expect(hits[0]!.path).toBe("src/billing.ts");
  expect(hits[0]!.startLine).toBe(1);
  const top = (await cipher.decrypt(tenantId, hits[0]!.contentCiphertext, "chunk")).toString();
  expect(top).toContain("computeInvoiceTotal");
  const graphHits = hits.filter((h) => h.via.includes("graph"));
  expect(graphHits.map((h) => `${h.path}:${h.startLine}`)).toEqual(expect.arrayContaining(["src/billing.ts:5", "src/math.ts:1"]));

  const blobSha = (await source.listFiles(C1)).find((f) => f.path === "src/billing.ts")!.blobSha;
  const blob = (await store.get(tenantKey(tenantId, "blobs", blobSha)))!;
  expect(blob.includes(Buffer.from("computeInvoiceTotal"))).toBe(false);
  expect((await cipher.decrypt(tenantId, blob, `blob:${blobSha}`)).toString()).toBe(files["src/billing.ts"]);
  expect(store.keys().some((k) => k.includes("node_modules"))).toBe(false);
});

test("push update: branch head lookup, already-indexed commit is not rebuilt, invalidation", async () => {
  const handle = makeHandler({ db: t.db, store, cipher, router, source });
  const push = (commitSha: string, indexId: string) => ({ ...msg(commitSha, "incremental", indexId), payload: { ...msg(commitSha, "incremental", indexId).payload, branch: "main" } });
  const head = () => withTenant(t.db, tenantId, (sql) => branchHead(sql, repoId, "main"));
  // C1 is already indexed (idx-1): the push only moves the head, nothing is re-read.
  source.reads.length = 0;
  const r1 = await handle(push(C1, "idx-push-1"));
  expect(r1).toMatchObject({ indexId: "idx-1", parsed: 0 });
  expect(source.reads).toHaveLength(0);
  expect((await head())!.id).toBe("idx-1");
  expect((await withTenant(t.db, tenantId, (sql) => readyIndexForCommit(sql, repoId, C2)))!.id).toBe("idx-2");
  await handle(push(C2, "idx-push-2"));
  expect((await head())!.commitSha).toBe(C2);
  expect(await withTenant(t.db, tenantId, (sql) => invalidateBranchHead(sql, repoId, "main"))).toBe(1);
  // An API-created pending record for an already-indexed commit resolves to ready (not stuck pending).
  await withTenant(t.db, tenantId, (sql) => createIndexRecord(sql, tenantId, { id: "idx-api", repositoryId: repoId, commitSha: C2, embedModel: "hash" }));
  expect(await handle(msg(C2, "incremental", "idx-api"))).toMatchObject({ indexId: "idx-2" });
  expect(await withTenant(t.db, tenantId, (sql) => getIndexRecord(sql, "idx-api"))).toMatchObject({ status: "ready", baseIndexId: "idx-2", symbolCount: 6 });
  expect(await head()).toBeUndefined();
});

test("failed build marks index failed", async () => {
  const handle = makeHandler({ db: t.db, store, cipher, router, source });
  await expect(handle(msg("c".repeat(40), "full", "idx-bad"))).rejects.toThrow(/unknown commit/);
  const r = await withTenant(t.db, tenantId, (sql) => sql.query<{ status: string }>("SELECT status FROM repo_indexes WHERE id = 'idx-bad'"));
  expect(r.rows[0]!.status).toBe("failed");
});
