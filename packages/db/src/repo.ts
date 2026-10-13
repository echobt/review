import { createHash } from "node:crypto";
import { TenantConfig } from "@review/core";
import type { Sql } from "./db.ts";

/** API keys are stored as sha256 hashes of a high-entropy random token (never the token itself). */
export const hashApiKey = (key: string): Buffer => createHash("sha256").update(key, "utf8").digest();

/** Resolve an API key to its tenant via the SECURITY DEFINER lookup (works before a tenant is known). */
export async function authenticateApiKey(sql: Sql, key: string): Promise<string | undefined> {
  const r = await sql.query<{ t: string | null }>("SELECT auth_api_key($1) AS t", [hashApiKey(key)]);
  return r.rows[0]?.t ?? undefined;
}

export async function resolveInstallation(sql: Sql, provider: string, externalId: string): Promise<string | undefined> {
  const r = await sql.query<{ t: string | null }>("SELECT resolve_installation($1, $2) AS t", [provider, externalId]);
  return r.rows[0]?.t ?? undefined;
}

/** Append-only audit record. detail must never contain code, prompts or secrets. */
export async function audit(sql: Sql, tenantId: string, actor: string, action: string, target?: string, detail: Record<string, unknown> = {}) {
  await sql.query("INSERT INTO audit_log (tenant_id, actor, action, target, detail) VALUES ($1, $2, $3, $4, $5)",
    [tenantId, actor, action, target ?? null, JSON.stringify(detail)]);
}

export async function getTenantConfig(sql: Sql, tenantId: string): Promise<TenantConfig> {
  const r = await sql.query<{ config: unknown }>("SELECT config FROM tenant_configs WHERE tenant_id = $1", [tenantId]);
  return TenantConfig.parse(r.rows[0]?.config ?? {});
}

export async function putTenantConfig(sql: Sql, tenantId: string, config: TenantConfig): Promise<TenantConfig> {
  const parsed = TenantConfig.parse(config);
  await sql.query(`INSERT INTO tenant_configs (tenant_id, config) VALUES ($1, $2)
    ON CONFLICT (tenant_id) DO UPDATE SET config = EXCLUDED.config, updated_at = now()`, [tenantId, JSON.stringify(parsed)]);
  return parsed;
}
