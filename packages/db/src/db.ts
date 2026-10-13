import pg from "pg";
import { APP_ROLE, TENANT_SETTING } from "./rls.ts";
import { MIGRATIONS } from "./migrations.ts";

/** Minimal query surface shared by node-postgres and PGlite. */
export interface Sql {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export interface Database {
  /** Run fn in one transaction. */
  tx<T>(fn: (sql: Sql) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The only supported way to touch tenant data (ADR 0007): a transaction with app.tenant_id set LOCAL,
 * so the setting cannot leak to the next user of a pooled connection.
 */
export async function withTenant<T>(db: Database, tenantId: string, fn: (sql: Sql) => Promise<T>): Promise<T> {
  if (!UUID.test(tenantId)) throw new Error("withTenant: tenantId must be a uuid");
  return db.tx(async (sql) => {
    await sql.query(`SELECT set_config('${TENANT_SETTING}', $1, true)`, [tenantId]);
    return fn(sql);
  });
}

export interface DbOptions {
  /** SET LOCAL ROLE for every transaction. Used when connected as an owner (tests, PGlite) to drop to the app role. */
  role?: string;
}

/** node-postgres pool. In production connect as review_app directly (no role switch needed). */
export function pgDatabase(connectionString: string, opts: DbOptions & { max?: number } = {}): Database {
  const pool = new pg.Pool({ connectionString, max: opts.max ?? 10 });
  return {
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        if (opts.role) await client.query(`SET LOCAL ROLE ${opts.role}`);
        const out = await fn({ query: async (text, params) => ({ rows: (await client.query(text, params as unknown[])).rows }) });
        await client.query("COMMIT");
        return out;
      } catch (e) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw e;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

/** Structural type of the PGlite instance methods we use (keeps @electric-sql/pglite a dev-only dependency). */
export interface PGliteLike {
  query<T>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
  exec(text: string): Promise<unknown>;
  transaction<T>(fn: (tx: { query<R>(text: string, params?: unknown[]): Promise<{ rows: R[] }> }) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export function pgliteDatabase(pgl: PGliteLike, opts: DbOptions = {}): Database {
  return {
    tx: (fn) => pgl.transaction(async (t) => {
      if (opts.role) await t.query(`SET LOCAL ROLE ${opts.role}`);
      return fn({ query: (text, params) => t.query(text, params) });
    }),
    close: () => pgl.close(),
  };
}

/** Apply pending migrations (idempotent, tracked in schema_migrations). Must run as the schema owner. */
export async function migrate(exec: { query: Sql["query"] }, opts: { appRolePassword?: string } = {}): Promise<string[]> {
  await exec.query("CREATE TABLE IF NOT EXISTS schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
  const done = new Set((await exec.query<{ id: string }>("SELECT id FROM schema_migrations")).rows.map((r) => r.id));
  const applied: string[] = [];
  for (const m of MIGRATIONS) {
    if (done.has(m.id)) continue;
    await exec.query("BEGIN");
    try {
      await runScript(exec, m.sql);
      await exec.query("INSERT INTO schema_migrations (id) VALUES ($1)", [m.id]);
      await exec.query("COMMIT");
    } catch (e) {
      await exec.query("ROLLBACK");
      throw new Error(`migration ${m.id} failed: ${(e as Error).message}`);
    }
    applied.push(m.id);
  }
  if (opts.appRolePassword) {
    // Password comes from env/secret file at deploy time; quote_literal-style escaping.
    await exec.query(`ALTER ROLE ${APP_ROLE} LOGIN PASSWORD '${opts.appRolePassword.replaceAll("'", "''")}'`);
  }
  return applied;
}

/** node-postgres accepts multi-statement text without params; PGlite needs exec(). */
async function runScript(exec: { query: Sql["query"]; exec?: (s: string) => Promise<unknown> }, sql: string) {
  if (typeof exec.exec === "function") await exec.exec(sql);
  else await exec.query(sql);
}
