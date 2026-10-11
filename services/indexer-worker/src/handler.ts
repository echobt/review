import type { Message } from "@review/core";
import { EnvelopeCipher, LocalKms, VaultTransitKms } from "@review/crypto";
import { pgDatabase, type Database } from "@review/db";
import { defaultPolicy, MemoryBudgetLedger, ModelRouter, providersFromEnv } from "@review/models";
import { loadConfig, memoryObjectStore, readSecret, s3ObjectStore, type ServiceConfig } from "@review/service-common";
import { gitRepoSource, indexRepository, type IndexerDeps, type IndexResult } from "./indexer.ts";

export function makeHandler(deps: IndexerDeps) {
  return (msg: Message<"index.requested">): Promise<IndexResult> => indexRepository(deps, msg);
}

/**
 * Production deps from env. RUNTIME_MODE=memory has no Postgres: returns undefined so the worker boots
 * (health checks) and skips jobs. REPO_MIRROR_DIR points at a local git mirror for gitRepoSource.
 */
export function createIndexerDeps(cfg: ServiceConfig, env: NodeJS.ProcessEnv = process.env): IndexerDeps | undefined {
  if (cfg.RUNTIME_MODE === "memory") return undefined;
  const vaultToken = readSecret("VAULT_TOKEN", env);
  const masterKey = readSecret("LOCAL_KMS_MASTER_KEY", env);
  if (!vaultToken && !masterKey) throw new Error("indexer: set VAULT_ADDR+VAULT_TOKEN or LOCAL_KMS_MASTER_KEY");
  const kms = vaultToken && env.VAULT_ADDR ? new VaultTransitKms({ addr: env.VAULT_ADDR, token: vaultToken }) : new LocalKms(Buffer.from(masterKey!, "base64"));
  const db: Database = pgDatabase(cfg.DATABASE_URL);
  // ponytail: in-process budget ledger; switch to the usage_ledger-backed one when @review/models ships it.
  const router = new ModelRouter(defaultPolicy, { providers: providersFromEnv(env), budget: new MemoryBudgetLedger({ prUsd: 5, tenantMonthlyUsd: 500 }) });
  return {
    db, router, cipher: new EnvelopeCipher(kms),
    store: cfg.S3_ENDPOINT || env.AWS_REGION ? s3ObjectStore({ ...(cfg.S3_ENDPOINT ? { endpoint: cfg.S3_ENDPOINT } : {}), bucket: cfg.S3_BUCKET, region: cfg.S3_REGION }) : memoryObjectStore(),
    source: gitRepoSource(env.REPO_MIRROR_DIR ?? "/var/lib/review/repos/current"),
  };
}

let prod: ((m: Message<"index.requested">) => Promise<IndexResult>) | undefined;

/** Queue entry point with lazily-built production deps. */
export async function handle(msg: Message<"index.requested">): Promise<IndexResult> {
  if (!prod) {
    const deps = createIndexerDeps(loadConfig());
    if (!deps) throw new Error("indexer: no database in RUNTIME_MODE=memory");
    prod = makeHandler(deps);
  }
  return prod(msg);
}
