// Run the review engine on greptile-50 cases (the real runReview path: indexer -> context pack -> planner/hunters/verifier).
// Usage:
//   MODEL_PROVIDER=gateway GATEWAY_BASE_URL=... GATEWAY_API_KEY=... MODEL_SMALL=... MODEL_MEDIUM=... MODEL_LARGE=... \
//   node scripts/bench/run.ts --repo sentry --mirrors <dir with <repo>-greptile git clones> --out bench-runs/<name> [--cases sentry-01,sentry-03]
//     [--engine multi-agent|single-pass] [--depth fast|standard|deep|auto] [--pr-usd 5] [--concurrency 3] [--warm]
//   SLO measurement (LATENCY-PLAN §8.2): --concurrency 1 --warm (index warmed off the clock, as the standing index is in production).
// Leakage rule (GREPTILE-GAP §1.2): the engine sees only repo@headSha and diff(base..head); never labels, PR comments or the fix.
import { execFile } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { promisify } from "node:util";
import { TenantConfig } from "@review/core";
import { MemoryBudgetLedger, ModelRouter, policyFromEnv, providersFromEnv } from "@review/models";
import { createProducer, memoryTransport } from "@review/queue";
import { runAgent } from "@review/agent-runner";
import { gitMirrorIndexer, RepoCache, runReview } from "@review/review-orchestrator";

const exec = promisify(execFile);
const arg = (k: string, d?: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const datasetPath = arg("--dataset", new URL("../../docs/scoring/datasets/greptile-50/dataset.json", import.meta.url).pathname)!;
const mirrors = arg("--mirrors");
const outDir = arg("--out", `bench-runs/${new Date().toISOString().replace(/[:.]/g, "-")}`)!;
const engine = arg("--engine", "multi-agent");
const depth = arg("--depth", "standard") as "fast" | "standard" | "deep" | "auto";
const prUsd = Number(arg("--pr-usd", "5"));
const width = Number(arg("--concurrency", "2"));
if (!mirrors) { console.error("--mirrors <dir> is required (git clones named <repo>-greptile)"); process.exit(2); }

interface DCase { id: string; repo: string; baseSha: string; headSha: string }
const ds = JSON.parse(readFileSync(datasetPath, "utf8")) as { cases: DCase[] };
const wanted = arg("--cases")?.split(",");
const repo = arg("--repo");
const cases = ds.cases.filter((c) => (!wanted || wanted.includes(c.id)) && (!repo || c.id.startsWith(repo.replace(".", ""))));

const policy = policyFromEnv();
const ledger = new MemoryBudgetLedger(() => ({ prUsd, tenantMonthlyUsd: 10_000 }));
const router = new ModelRouter(policy, { providers: providersFromEnv(), budget: ledger });
const repos = new RepoCache(mirrors);
const indexer = gitMirrorIndexer(repos);
const warm = process.argv.includes("--warm");
const config = TenantConfig.parse({ reviewDepth: depth, learning: false, maxComments: 15 }); // benchmark = default settings, no learning (S200)
mkdirSync(outDir, { recursive: true });
writeFileSync(`${outDir}/config.json`, JSON.stringify({ engine, depth, prUsd, tiers: Object.fromEntries(Object.entries(policy.tiers).map(([k, v]) => [k, v.map((t) => `${t.provider}/${t.model}`)])), cases: cases.map((c) => c.id), startedAt: new Date().toISOString() }, null, 1));

async function one(c: DCase) {
  const file = `${outDir}/${c.id}.json`;
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
  const repoId = c.repo.split("/").pop()!;
  const dir = `${mirrors}/${repoId}`;
  for (const sha of [c.baseSha, c.headSha]) await repos.ensureCommit(repoId, sha);
  // Three-dot semantics like a GitHub PR: diff from the merge base.
  const mb = (await exec("git", ["-C", dir, "merge-base", c.baseSha, c.headSha]).then((r) => r.stdout.trim(), () => c.baseSha)) || c.baseSha;
  const diff = (await exec("git", ["-C", dir, "diff", "--no-color", "-M", mb, c.headSha], { maxBuffer: 256 << 20 })).stdout;
  if (warm) {
    // Cold start is off the review clock in production (push-time index); measure it separately.
    const w0 = Date.now();
    const parsed = await indexer.standing.warm(await indexer.ensureIndexed(repoId, c.headSha), diff.match(/^\+\+\+ b\/(.+)$/gm)?.map((l) => l.slice(6)));
    appendFileSync(`${outDir}/${c.id}.events.jsonl`, JSON.stringify({ t: 0, event: "warm", ms: Date.now() - w0, parsed }) + "\n");
  }
  const events: Record<string, unknown>[] = [];
  const t0 = Date.now();
  let peakHeap = 0;
  const heap = setInterval(() => {
    const h = process.memoryUsage().heapUsed; peakHeap = Math.max(peakHeap, h);
    appendFileSync(`${outDir}/${c.id}.events.jsonl`, JSON.stringify({ t: Date.now() - t0, event: "heap", heapUsed: h }) + "\n");
  }, 10_000);
  try {
    const out = await runReview({
      executor: (req) => runAgent({ router }, req), producer: createProducer(memoryTransport()), config,
      ...(engine === "multi-agent" ? { indexer, router } : {}), log: (e) => { const ev = { t: Date.now() - t0, ...e }; events.push(ev); appendFileSync(`${outDir}/${c.id}.events.jsonl`, JSON.stringify(ev) + "\n"); },
    }, { tenantId: "bench", reviewId: c.id, repositoryId: repoId, diff, headSha: c.headSha });
    const rec = { caseId: c.id, ok: true, engine: out.engine, latencyMs: Date.now() - t0, peakHeap, usage: out.usage, partial: out.partial, stats: out.stats, summary: out.summary,
      findings: out.findings.map((f) => ({ title: f.title, body: f.body, category: f.category, severity: f.severity, confidence: f.confidence, location: f.location, source: f.source })), events };
    writeFileSync(file, JSON.stringify(rec, null, 1));
    return rec;
  } catch (e) {
    const rec = { caseId: c.id, ok: false, error: (e as Error).message, latencyMs: Date.now() - t0, peakHeap, findings: [], events };
    writeFileSync(file, JSON.stringify(rec, null, 1));
    return rec;
  } finally { clearInterval(heap); }
}

let next = 0;
await Promise.all(Array.from({ length: Math.min(width, cases.length) }, async () => {
  while (next < cases.length) {
    const c = cases[next++]!;
    const r = await one(c);
    console.error(`${c.id} ok=${r.ok} findings=${r.findings.length} cost=${r.usage?.costUsd?.toFixed?.(4) ?? "-"} ${Math.round(r.latencyMs / 1000)}s${r.error ? " error=" + r.error : ""}`);
  }
}));
console.error(`done: ${outDir}`);
