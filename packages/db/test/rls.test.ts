import { describe, expect, test, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { APP_ROLE, TENANT_TABLES, migrate, pgDatabase, rlsPolicySql, withTenant, type Database, type Sql } from "../src/index.ts";
import { createTestDatabase } from "../src/testing.ts";

const vec = `[${Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0)).join(",")}]`;

/** One insertable row per tenant table. `$t` = tenant id, `$s` = per-tenant unique suffix. Parents first. */
const FIXTURES: Record<string, string> = {
  installations: "INSERT INTO installations (id, tenant_id, provider, external_id) VALUES ('inst-$s', '$t', 'github', 'ext-$s')",
  repositories: "INSERT INTO repositories (id, tenant_id, provider, full_name) VALUES ('repo-$s', '$t', 'github', 'o/r-$s')",
  api_keys: "INSERT INTO api_keys (id, tenant_id, prefix, key_hash) VALUES ('key-$s', '$t', 'rk_', decode(md5('$s'), 'hex'))",
  audit_log: "INSERT INTO audit_log (tenant_id, actor, action) VALUES ('$t', 'test', 'created')",
  tenant_configs: "INSERT INTO tenant_configs (tenant_id, config) VALUES ('$t', '{}')",
  rules: "INSERT INTO rules (id, tenant_id, data) VALUES ('rule-$s', '$t', '{}')",
  repo_indexes: "INSERT INTO repo_indexes (id, tenant_id, repository_id, commit_sha, status, embed_model) VALUES ('idx-$s', '$t', 'repo-$s', 'abc1234', 'ready', 'm')",
  index_files: "INSERT INTO index_files (tenant_id, index_id, path, blob_sha, object_key) VALUES ('$t', 'idx-$s', 'a.ts', 'b1', 'k')",
  symbols: "INSERT INTO symbols (id, tenant_id, index_id, blob_sha, path, kind, name, fq_name, start_line, end_line) VALUES ('sym-$s', '$t', 'idx-$s', 'b1', 'a.ts', 'function', 'f', 'a.f', 1, 2)",
  symbol_edges: "INSERT INTO symbol_edges (tenant_id, index_id, src_symbol_id, path, kind, dst_name, line) VALUES ('$t', 'idx-$s', 'sym-$s', 'a.ts', 'call', 'g', 1)",
  chunks: `INSERT INTO chunks (id, tenant_id, index_id, path, start_line, end_line, blob_sha, content_hash, content_ciphertext, tsv, embedding) VALUES ('chk-$s', '$t', 'idx-$s', 'a.ts', 1, 2, 'b1', 'h', '\\x00', to_tsvector('simple', 'f'), '${vec}')`,
  branch_heads: "INSERT INTO branch_heads (tenant_id, repository_id, branch, index_id, commit_sha) VALUES ('$t', 'repo-$s', 'main', 'idx-$s', 'abc1234')",
  embedding_cache: `INSERT INTO embedding_cache (tenant_id, model, content_hash, embedding) VALUES ('$t', 'm', 'h', '${vec}')`,
  pull_requests: "INSERT INTO pull_requests (id, tenant_id, repository_id, number) VALUES ('pr-$s', '$t', 'repo-$s', 1)",
  reviews: "INSERT INTO reviews (id, tenant_id, repository_id, status) VALUES ('rev-$s', '$t', 'repo-$s', 'queued')",
  agent_tasks: "INSERT INTO agent_tasks (id, tenant_id, review_id, kind, tier, status) VALUES ('at-$s', '$t', 'rev-$s', 'bug-hunter', 'small', 'done')",
  findings: "INSERT INTO findings (id, tenant_id, review_id, fingerprint, category, severity, path, start_line, end_line, confidence, data) VALUES ('f-$s', '$t', 'rev-$s', 'fp', 'bug', 'high', 'a.ts', 1, 1, 0.9, '{}')",
  feedback: "INSERT INTO feedback (id, tenant_id, finding_id, verdict) VALUES ('fb-$s', '$t', 'f-$s', 'dismissed')",
  suppressions: "INSERT INTO suppressions (id, tenant_id, repository_id, fingerprint, reason) VALUES ('sup-$s', '$t', 'repo-$s', 'fp', 'dismissed')",
  test_gen_runs: "INSERT INTO test_gen_runs (id, tenant_id, repository_id, status, target_paths) VALUES ('tg-$s', '$t', 'repo-$s', 'queued', '{a.ts}')",
  sandbox_runs: "INSERT INTO sandbox_runs (id, tenant_id, image, command, status) VALUES ('sb-$s', '$t', 'node:24', '[\"true\"]', 'done')",
  score_reports: "INSERT INTO score_reports (id, tenant_id, rubric_version, dataset_version, score, data) VALUES ('sr-$s', '$t', '1.0.0', 's', 50, '{}')",
  usage_ledger: "INSERT INTO usage_ledger (tenant_id, model, input_tokens, output_tokens, cost_usd) VALUES ('$t', 'm', 1, 1, 0)",
};
const fill = (s: string, t: string, suffix: string) => s.replaceAll("$t", t).replaceAll("$s", suffix);
const count = async (sql: Sql, table: string) => Number((await sql.query<{ c: string }>(`SELECT count(*) AS c FROM ${table}`)).rows[0]!.c);

test("policy generator emits ENABLE + FORCE + USING/WITH CHECK and rejects unsafe identifiers", () => {
  const s = rlsPolicySql({ table: "findings" });
  expect(s).toContain('ALTER TABLE "findings" ENABLE ROW LEVEL SECURITY;');
  expect(s).toContain('ALTER TABLE "findings" FORCE ROW LEVEL SECURITY;');
  expect(s).toMatch(/USING \("tenant_id" = NULLIF\(current_setting\('app\.tenant_id', true\), ''\)::uuid\) WITH CHECK \("tenant_id" = /);
  expect(s).toContain(`TO ${APP_ROLE}`);
  expect(rlsPolicySql({ table: "audit_log", grants: ["SELECT", "INSERT"] })).toContain("GRANT SELECT, INSERT ON");
  expect(() => rlsPolicySql({ table: "x; DROP TABLE y" })).toThrow(/unsafe/);
});

interface Harness { db: Database; ownerQuery: Sql["query"]; newTenant: () => Promise<string>; close: () => Promise<void> }

async function pgliteHarness(): Promise<Harness> {
  const h = await createTestDatabase();
  return { db: h.db, ownerQuery: (t, p) => h.owner.query(t, p), newTenant: () => h.newTenant(), close: () => h.owner.close() };
}

/** Real Postgres 16 (CI service / docker compose): a throwaway database, migrated, then dropped. */
async function pgHarness(url: string): Promise<Harness> {
  const name = `rls_test_${process.pid}_${Date.now()}`;
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  const u = new URL(url); u.pathname = `/${name}`;
  const owner = new pg.Client({ connectionString: u.toString() });
  await owner.connect();
  await migrate({ query: async (t: string, p?: unknown[]) => ({ rows: (await owner.query(t, p)).rows }) } as never);
  const db = pgDatabase(u.toString(), { role: APP_ROLE, max: 2 });
  return {
    db,
    ownerQuery: async (t, p) => ({ rows: (await owner.query(t, p)).rows }),
    newTenant: async () => (await owner.query("INSERT INTO tenants (name) VALUES ('t') RETURNING id")).rows[0].id as string,
    close: async () => { await db.close(); await owner.end(); await admin.query(`DROP DATABASE ${name}`); await admin.end(); },
  };
}

const targets: [string, () => Promise<Harness>][] = [["pglite", pgliteHarness]];
if (process.env.RLS_DATABASE_URL) targets.push(["postgres", () => pgHarness(process.env.RLS_DATABASE_URL!)]);

describe.each(targets)("tenant isolation on %s", (_name, make) => {
  let h: Harness, a: string, b: string;
  beforeAll(async () => {
    h = await make();
    a = await h.newTenant(); b = await h.newTenant();
    for (const [t, s] of [[a, "a"], [b, "b"]] as const) {
      await withTenant(h.db, t, async (sql) => { for (const q of Object.values(FIXTURES)) await sql.query(fill(q, t, s)); });
    }
  }, 120_000);
  afterAll(async () => { await h?.close(); });

  test("every table with a tenant_id column is in TENANT_TABLES, has RLS enabled and FORCED", async () => {
    const cols = await h.ownerQuery<{ table_name: string }>(
      "SELECT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'tenant_id'");
    const expected = new Set([...cols.rows.map((r) => r.table_name), "tenants"]);
    expect(new Set(TENANT_TABLES.map((t) => t.table))).toEqual(expected);
    const flags = await h.ownerQuery<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      "SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = ANY($1)", [[...expected]]);
    expect(flags.rows).toHaveLength(expected.size);
    for (const f of flags.rows) expect([f.relname, f.relrowsecurity, f.relforcerowsecurity]).toEqual([f.relname, true, true]);
    expect(Object.keys(FIXTURES).sort()).toEqual(TENANT_TABLES.map((t) => t.table).filter((t) => t !== "tenants").sort());
  });

  test("no tenant set: every tenant table reads as empty", async () => {
    await h.db.tx(async (sql) => { for (const { table } of TENANT_TABLES) expect([table, await count(sql, table)]).toEqual([table, 0]); });
  });

  test("tenants root: each tenant sees only itself", async () => {
    const ids = await withTenant(h.db, a, async (sql) => (await sql.query<{ id: string }>("SELECT id FROM tenants")).rows.map((r) => r.id));
    expect(ids).toEqual([a]);
  });

  test.each(Object.keys(FIXTURES))("%s: cross-tenant read, update, delete and insert are rejected", async (table) => {
    const grants = TENANT_TABLES.find((t) => t.table === table)!.grants ?? ["SELECT", "INSERT", "UPDATE", "DELETE"];
    await withTenant(h.db, a, async (sql) => {
      expect(await count(sql, table)).toBe(1);
      const own = (await sql.query<{ tenant_id: string }>(`SELECT DISTINCT tenant_id FROM ${table}`)).rows.map((r) => r.tenant_id);
      expect(own).toEqual([a]);
    });
    if (grants.includes("UPDATE")) {
      const n = await withTenant(h.db, b, async (sql) => (await sql.query(`UPDATE ${table} SET tenant_id = tenant_id WHERE tenant_id = '${a}' RETURNING 1`)).rows.length);
      expect(n).toBe(0);
    }
    if (grants.includes("DELETE")) {
      const n = await withTenant(h.db, b, async (sql) => (await sql.query(`DELETE FROM ${table} WHERE tenant_id = '${a}' RETURNING 1`)).rows.length);
      expect(n).toBe(0);
    }
    // Tenant B writing a row stamped with tenant A must violate WITH CHECK (or an FK to A's invisible parents).
    await expect(withTenant(h.db, b, (sql) => sql.query(fill(FIXTURES[table]!, a, "x")))).rejects.toThrow();
    await withTenant(h.db, a, async (sql) => expect(await count(sql, table)).toBe(1));
  });

  test("app role cannot UPDATE or DELETE append-only audit_log", async () => {
    await expect(withTenant(h.db, a, (sql) => sql.query("DELETE FROM audit_log"))).rejects.toThrow(/permission denied/);
  });
});
