import { expect, test } from "vitest";
import { parseMessage } from "@review/core";
import { withTenant } from "@review/db";
import { createTestDatabase } from "@review/db/testing";
import { tenantKey } from "@review/queue";
import { memoryObjectStore } from "@review/service-common";
import { handle } from "../src/handler.ts";
import { MockSandboxDriver } from "../src/sandbox.ts";

const mk = (tenantId: string, payload: Record<string, unknown>) => parseMessage("sandbox.run", {
  messageId: "7f1d2c9e-8a8b-4c4e-9d55-1d0f3b9a2c11", tenantId, createdAt: "2026-10-11T00:00:00Z",
  payload: { runId: "run1", image: "node:24", command: ["node", "a.js"], workspaceObjectKey: tenantKey(tenantId, "ws", "w1"), timeoutSec: 60, ...payload },
});

test("sandbox.run: workspace in, result JSON out, sandbox_runs row written", async () => {
  const { db, newTenant } = await createTestDatabase();
  const tenantId = await newTenant();
  const store = memoryObjectStore();
  await store.put(tenantKey(tenantId, "ws", "w1"), Buffer.from(JSON.stringify({ files: { "a.js": "console.log(1)" } })));
  const driver = new MockSandboxDriver((s) => ({ stdout: String(s.files?.["a.js"]), exitCode: 0 }));
  const r = await handle(mk(tenantId, {}), { driver, store, db });
  expect(r).toMatchObject({ status: "completed", exitCode: 0, resultKey: `tenants/${tenantId}/sandbox-results/run1` });
  expect(JSON.parse((await store.get(r.resultKey))!.toString())).toMatchObject({ runId: "run1", stdout: "console.log(1)" });
  expect(driver.calls[0]!.limits).toMatchObject({ timeoutSec: 60, network: "none" });
  const rows = await withTenant(db, tenantId, (sql) => sql.query<{ status: string; exit_code: number; result_object_key: string }>("SELECT status, exit_code, result_object_key FROM sandbox_runs"));
  expect(rows.rows).toEqual([{ status: "completed", exit_code: 0, result_object_key: r.resultKey }]);
}, 60_000);

test("sandbox.run rejects cross-tenant workspace keys and records spec rejections", async () => {
  const store = memoryObjectStore();
  const driver = new MockSandboxDriver();
  await expect(handle(mk("t1", { workspaceObjectKey: tenantKey("t2", "ws", "w1") }), { driver, store })).rejects.toThrow(/tenant prefix/);
  await store.put(tenantKey("t1", "ws", "w1"), Buffer.from(JSON.stringify({ files: { "../x": "" } })));
  const r = await handle(mk("t1", {}), { driver, store });
  expect(r.status).toBe("rejected");
});
