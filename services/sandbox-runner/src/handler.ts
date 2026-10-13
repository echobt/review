import { z } from "zod";
import type { Message } from "@review/core";
import { withTenant, type Database } from "@review/db";
import { tenantKey } from "@review/queue";
import type { ObjectStore } from "@review/service-common";
import { SandboxSpecError, SandboxUnavailableError, type SandboxDriver } from "./sandbox.ts";

export const Workspace = z.object({ files: z.record(z.string(), z.string()) });

export interface HandlerDeps { driver: SandboxDriver; store: ObjectStore; db?: Database }

export interface RunRecord { runId: string; status: "completed" | "timed_out" | "rejected" | "unavailable"; exitCode?: number; stdout?: string; stderr?: string; durationMs?: number; error?: string }

export async function handle(msg: Message<"sandbox.run">, deps: HandlerDeps): Promise<RunRecord & { resultKey: string }> {
  const p = msg.payload;
  if (!p.workspaceObjectKey.startsWith(`${tenantKey(msg.tenantId)}/`)) throw new Error("workspace key outside tenant prefix");
  const blob = await deps.store.get(p.workspaceObjectKey);
  if (!blob) throw new Error("workspace object not found");
  const ws = Workspace.parse(JSON.parse(blob.toString("utf8")));
  let rec: RunRecord;
  try {
    const r = await deps.driver.run({ image: p.image, command: p.command, files: ws.files, limits: { ...p.limits, timeoutSec: p.timeoutSec, network: p.network } });
    rec = { runId: p.runId, status: r.timedOut ? "timed_out" : "completed", exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr, durationMs: r.durationMs };
  } catch (e) {
    if (!(e instanceof SandboxSpecError || e instanceof SandboxUnavailableError)) throw e;
    rec = { runId: p.runId, status: e instanceof SandboxSpecError ? "rejected" : "unavailable", error: e.message };
  }
  const resultKey = tenantKey(msg.tenantId, "sandbox-results", p.runId);
  await deps.store.put(resultKey, Buffer.from(JSON.stringify(rec)));
  if (deps.db) {
    await withTenant(deps.db, msg.tenantId, (sql) => sql.query(
      `INSERT INTO sandbox_runs (id, tenant_id, image, command, status, exit_code, result_object_key) VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, exit_code = EXCLUDED.exit_code, result_object_key = EXCLUDED.result_object_key`,
      [p.runId, msg.tenantId, p.image, JSON.stringify(p.command), rec.status, rec.exitCode ?? null, resultKey]));
  }
  return { ...rec, resultKey };
}
