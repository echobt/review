import { MemoryBudgetLedger, ModelRouter, defaultPolicy, providersFromEnv } from "@review/models";
import { pgDatabase } from "@review/db";
import { createProducer } from "@review/queue";
import { memoryObjectStore, readSecret, runWorker, s3ObjectStore } from "@review/service-common";
// ponytail: relative import keeps agent-runner out of this package's deps; switch to "@review/agent-runner" (workspace dep) once installed.
import { runAgent } from "@review/agent-runner";
import { OctokitlessGitHubClient } from "./github.ts";
import { handle } from "./handler.ts";

await runWorker("review-orchestrator", "review.requested", ({ cfg, transport }) => {
  const memory = cfg.RUNTIME_MODE === "memory";
  const db = memory ? undefined : pgDatabase(cfg.DATABASE_URL);
  const store = memory ? memoryObjectStore() : s3ObjectStore({ bucket: cfg.S3_BUCKET, region: cfg.S3_REGION, ...(cfg.S3_ENDPOINT ? { endpoint: cfg.S3_ENDPOINT } : {}) });
  // ponytail: per-worker in-memory budget ledger; replace with a usage_ledger-backed ledger for cross-process caps.
  const router = new ModelRouter(defaultPolicy, { providers: providersFromEnv(), budget: new MemoryBudgetLedger((_t) => ({ prUsd: 0.5, tenantMonthlyUsd: 500 })) });
  // ponytail: static installation token from env; replace with GitHub App JWT -> installation token exchange.
  const token = readSecret("GITHUB_TOKEN");
  const github = token ? new OctokitlessGitHubClient(async () => token) : undefined;
  const producer = createProducer(transport);
  return async (msg) => {
    await handle({ store, producer, executor: (req) => runAgent({ router, ...(db ? { db } : {}) }, req), ...(db ? { db } : {}), ...(github ? { github } : {}) }, msg);
  };
});
