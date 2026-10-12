import { MemoryBudgetLedger, ModelRouter, policyFromEnv, providersFromEnv } from "@review/models";
import { pgDatabase } from "@review/db";
import { createProducer } from "@review/queue";
import { memoryObjectStore, readSecret, runWorker, s3ObjectStore } from "@review/service-common";
import { runAgent } from "@review/agent-runner";
import { sandboxExecutor, selectDriver } from "@review/sandbox-runner";
import { OctokitlessGitHubClient } from "./github.ts";
import { handle } from "./handler.ts";
import { gitMirrorIndexer, gitWorktree } from "./pack.ts";

await runWorker("review-orchestrator", "review.requested", ({ cfg, transport }) => {
  const memory = cfg.RUNTIME_MODE === "memory";
  const db = memory ? undefined : pgDatabase(cfg.DATABASE_URL);
  const store = memory ? memoryObjectStore() : s3ObjectStore({ bucket: cfg.S3_BUCKET, region: cfg.S3_REGION, ...(cfg.S3_ENDPOINT ? { endpoint: cfg.S3_ENDPOINT } : {}) });
  // ponytail: per-worker in-memory budget ledger; replace with a usage_ledger-backed ledger for cross-process caps.
  const router = new ModelRouter(policyFromEnv(), { providers: providersFromEnv(), budget: new MemoryBudgetLedger((_t) => ({ prUsd: 0.5, tenantMonthlyUsd: 500 })) });
  // ponytail: static installation token from env; replace with GitHub App JWT -> installation token exchange.
  const token = readSecret("GITHUB_TOKEN");
  const github = token ? new OctokitlessGitHubClient(async () => token) : undefined;
  const producer = createProducer(transport);
  // Multi-agent engine (GREPTILE-GAP): on when REVIEW_MIRROR_ROOT holds git mirrors (<root>/<repositoryId>); E0-E3 when REVIEW_EXECUTION=1.
  const mirrors = process.env.REVIEW_MIRROR_ROOT;
  const indexer = mirrors ? gitMirrorIndexer(mirrors) : undefined;
  const driver = mirrors && process.env.REVIEW_EXECUTION === "1" ? selectDriver(process.env) : undefined;
  const execution = driver && mirrors ? async (repo: string, sha: string) => sandboxExecutor(driver, await gitWorktree(mirrors, repo, sha, process.env.SANDBOX_WORKSPACE_ROOT ?? "/tmp/review-ws")) : undefined;
  return async (msg) => {
    await handle({ store, producer, executor: (req) => runAgent({ router, ...(db ? { db } : {}) }, req), ...(db ? { db } : {}), ...(github ? { github } : {}),
      ...(indexer ? { indexer, router } : {}), ...(execution ? { execution } : {}) }, msg);
  };
});
