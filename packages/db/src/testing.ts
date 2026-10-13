import { migrate, pgliteDatabase, type Database, type PGliteLike } from "./db.ts";
import { APP_ROLE } from "./rls.ts";

/**
 * In-process Postgres (PGlite + pgvector) with all migrations applied. The returned Database drops to the
 * non-owner app role in every transaction, so RLS is enforced exactly as in production.
 * Test-only: @electric-sql/pglite is a devDependency of consumers.
 */
export async function createTestDatabase(): Promise<{ db: Database; owner: PGliteLike; newTenant: (name?: string) => Promise<string> }> {
  const { PGlite } = await import("@electric-sql/pglite");
  const { vector } = await import("@electric-sql/pglite-pgvector");
  const owner = (await PGlite.create({ extensions: { vector } })) as unknown as PGliteLike;
  await migrate(owner as unknown as Parameters<typeof migrate>[0]);
  const db = pgliteDatabase(owner, { role: APP_ROLE });
  const newTenant = async (name = "t") =>
    (await owner.query<{ id: string }>("INSERT INTO tenants (name) VALUES ($1) RETURNING id", [name])).rows[0]!.id;
  return { db, owner, newTenant };
}
