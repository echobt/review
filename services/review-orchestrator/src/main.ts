import { MemoryBudgetLedger, ModelRouter, policyFromEnv, providersFromEnv } from "@review/models";
import { pgDatabase } from "@review/db";
import { createProducer } from "@review/queue";
import { memoryObjectStore, readSecret, runWorker, s3ObjectStore } from "@review/service-common";
import { runAgent } from "@review/agent-runner";
import { runSemgrep, sandboxExecutor, selectDriver } from "@review/sandbox-runner";
import { OctokitlessGitHubClient } from "./github.ts";
import { handle } from "./handler.ts";
import { gitMirrorIndexer } from "./pack.ts";
import { RepoCache } from "./repo-cache.ts";

await runWorker("review-orchestrator", "review.requested", ({ cfg, transport }) => {
  const memory = cfg.RUNTIME_MODE === "memory";
  const db = memory ? undefined : pgDatabase(cfg.DATABASE_URL);
  const store = memory ? memoryObjectStore() : s3ObjectStore({ bucket: cfg.S3_BUCKET, region: cfg.S3_REGION, ...(cfg.S3_ENDPOINT ? { endpoint: cfg.S3_ENDPOINT } : {}) });
  // ponytail: per-worker in-memory budget ledger; replace with a usage_ledger-backed ledger for cross-process caps.
  const mirrors = process.env.REVIEW_MIRROR_ROOT;
  // Multi-agent engine measured $1.3-$5/PR on Sentry (2/9 runs hit a $5 cap), so it defaults to $5; single-pass keeps $0.5. REVIEW_PR_USD overrides both.
  const prUsd = Number(process.env.REVIEW_PR_USD ?? (mirrors ? 5 : 0.5));
  if (!(prUsd > 0)) throw new Error("REVIEW_PR_USD must be a positive number");
  const router = new ModelRouter(policyFromEnv(), { providers: providersFromEnv(), budget: new MemoryBudgetLedger((_t) => ({ prUsd, tenantMonthlyUsd: 500 })) });
  // ponytail: static installation token from env; replace with GitHub App JWT -> installation token exchange.
  const token = readSecret("GITHUB_TOKEN");
  const github = token ? new OctokitlessGitHubClient(async () => token) : undefined;
  const producer = createProducer(transport);
  // Multi-agent engine (GREPTILE-GAP): on when REVIEW_MIRROR_ROOT holds git mirrors (<root>/<repositoryId>); E0-E3 when REVIEW_EXECUTION=1.
  // One partial mirror per repository (cloned once from REVIEW_REMOTE_TEMPLATE, e.g. https://github.com/{repo}.git), standing index per repo.
  const remote = process.env.REVIEW_REMOTE_TEMPLATE;
  const repos = mirrors ? new RepoCache(mirrors, { workspaceRoot: process.env.SANDBOX_WORKSPACE_ROOT ?? "/tmp/review-ws", ...(remote ? { remote: (id: string) => remote.replace("{repo}", id) } : {}) }) : undefined;
  const indexer = repos ? gitMirrorIndexer(repos) : undefined;
  const driver = mirrors && process.env.REVIEW_EXECUTION === "1" ? selectDriver(process.env) : undefined;
  const sastDriver = mirrors && process.env.REVIEW_SEMGREP === "1" ? driver ?? selectDriver(process.env) : undefined;
  // The sandbox has no network, so registry rulesets (p/...) cannot be fetched: require rules baked into the image (SEMGREP_RULES=/path).
  const rules = process.env.SEMGREP_RULES;
  if (sastDriver && !rules?.startsWith("/")) throw new Error("REVIEW_SEMGREP=1 requires SEMGREP_RULES to be an absolute path to rules inside the semgrep image (the sandbox has no network)");
  const semgrep = sastDriver && rules ? (files: Record<string, string>) => runSemgrep(sastDriver, { rules, files }) : undefined;
  const execution = driver && repos ? async (repo: string, sha: string) => { const wt = await repos.worktree(repo, sha); return { ...sandboxExecutor(driver, wt.dir), release: wt.release }; } : undefined;
  return async (msg) => {
    await handle({ store, producer, executor: (req) => runAgent({ router, ...(db ? { db } : {}) }, req), ...(db ? { db } : {}), ...(github ? { github } : {}),
      ...(indexer ? { indexer, router } : {}), ...(execution ? { execution } : {}), ...(semgrep ? { semgrep } : {}) }, msg);
  };
});
