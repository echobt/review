import { MemoryBudgetLedger, ModelRouter, policyFromEnv, providersFromEnv } from "@review/models";
import { pgDatabase } from "@review/db";
import { memoryObjectStore, runWorker, s3ObjectStore } from "@review/service-common";
import { handle } from "./handler.ts";

await runWorker("agent-runner", "agent.task", ({ cfg }) => {
  // ponytail: in-process budget ledger per worker; swap for a usage_ledger-backed ledger for cross-process caps.
  const router = new ModelRouter(policyFromEnv(), { providers: providersFromEnv(), budget: new MemoryBudgetLedger({ prUsd: 0.5, tenantMonthlyUsd: 500 }) });
  const memory = cfg.RUNTIME_MODE === "memory";
  const store = memory ? memoryObjectStore() : s3ObjectStore({ bucket: cfg.S3_BUCKET, region: cfg.S3_REGION, ...(cfg.S3_ENDPOINT ? { endpoint: cfg.S3_ENDPOINT } : {}) });
  const db = memory ? undefined : pgDatabase(cfg.DATABASE_URL);
  return async (msg) => { await handle({ router, store, ...(db ? { db } : {}) }, msg); };
});
