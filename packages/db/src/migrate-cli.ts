// Apply migrations as the schema owner. Usage: MIGRATION_DATABASE_URL=postgres://owner@... [APP_DB_PASSWORD_FILE=...] node packages/db/src/migrate-cli.ts
import { readFileSync } from "node:fs";
import pg from "pg";
import { migrate } from "./db.ts";

const url = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
if (!url) { console.error("set MIGRATION_DATABASE_URL"); process.exit(2); }
const pw = process.env.APP_DB_PASSWORD ?? (process.env.APP_DB_PASSWORD_FILE ? readFileSync(process.env.APP_DB_PASSWORD_FILE, "utf8").trim() : undefined);
const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  const applied = await migrate({ query: async (t: string, p?: unknown[]) => ({ rows: (await client.query(t, p)).rows }) }, pw ? { appRolePassword: pw } : {});
  console.log(JSON.stringify({ applied }));
} finally {
  await client.end();
}
