/** Session variable carrying the current tenant. Set only via SET LOCAL / set_config(..., true) inside a transaction. */
export const TENANT_SETTING = "app.tenant_id";
/** Non-owner application role. Has no BYPASSRLS. */
export const APP_ROLE = "review_app";

const ident = (s: string): string => {
  if (!/^[a-z_][a-z0-9_]*$/.test(s)) throw new Error(`unsafe SQL identifier: ${s}`);
  return `"${s}"`;
};

export interface RlsTable {
  table: string;
  /** Column holding the tenant id (default tenant_id; the tenants root table uses id). */
  column?: string;
  /** Privileges granted to the app role. Append-only tables omit UPDATE/DELETE. */
  grants?: readonly ("SELECT" | "INSERT" | "UPDATE" | "DELETE")[];
}

/**
 * RLS policy generator (ADR 0007). Emits ENABLE + FORCE ROW LEVEL SECURITY and one policy whose USING and
 * WITH CHECK both compare the tenant column with the transaction-local setting. An unset setting yields NULL,
 * so no rows are visible and every write is rejected (fail closed).
 */
export function rlsPolicySql({ table, column = "tenant_id", grants = ["SELECT", "INSERT", "UPDATE", "DELETE"] }: RlsTable): string {
  const t = ident(table), c = ident(column);
  const cur = `NULLIF(current_setting('${TENANT_SETTING}', true), '')::uuid`;
  return [
    `ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY;`,
    `ALTER TABLE ${t} FORCE ROW LEVEL SECURITY;`,
    `DROP POLICY IF EXISTS tenant_isolation ON ${t};`,
    `CREATE POLICY tenant_isolation ON ${t} USING (${c} = ${cur}) WITH CHECK (${c} = ${cur});`,
    `GRANT ${grants.join(", ")} ON ${t} TO ${APP_ROLE};`,
  ].join("\n");
}
