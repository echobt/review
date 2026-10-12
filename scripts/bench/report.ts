// Catch rate overall / per repo / per severity, cost and latency, next to the published numbers.
// Usage: node scripts/bench/report.ts --run bench-runs/<name> [--baseline bench-runs/<old>]
import { readFileSync, writeFileSync, existsSync } from "node:fs";

interface J { caseId: string; caught: boolean; ok: boolean; costUsd: number; latencyMs: number; findings: number }
const arg = (k: string, d?: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2) : 0; };

export function summarize(results: J[], ds: { cases: { id: string; publishedSeverity: string; published: Record<string, boolean> }[] }) {
  const byId = new Map(ds.cases.map((c) => [c.id, c]));
  const group = (key: (r: J) => string) => {
    const m: Record<string, { caught: number; of: number; greptile: number }> = {};
    for (const r of results) { const k = key(r); const g = (m[k] ??= { caught: 0, of: 0, greptile: 0 }); g.of++; if (r.caught) g.caught++; if (byId.get(r.caseId)?.published.greptile) g.greptile++; }
    return m;
  };
  return {
    caught: results.filter((r) => r.caught).length, of: results.length, failedRuns: results.filter((r) => !r.ok).length,
    greptileSameCases: results.filter((r) => byId.get(r.caseId)?.published.greptile).length,
    perRepo: group((r) => r.caseId.replace(/-\d+$/, "")), perSeverity: group((r) => byId.get(r.caseId)?.publishedSeverity ?? "?"),
    costUsd: { total: results.reduce((s, r) => s + r.costUsd, 0), medianPerPr: median(results.map((r) => r.costUsd)) },
    latencyS: { median: median(results.map((r) => r.latencyMs)) / 1000, max: Math.max(0, ...results.map((r) => r.latencyMs)) / 1000 },
    commentsPerPr: median(results.map((r) => r.findings)),
    cases: results.map((r) => ({ id: r.caseId, caught: r.caught, greptile: byId.get(r.caseId)?.published.greptile ?? null })),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const run = arg("--run")!;
  const ds = JSON.parse(readFileSync(arg("--dataset", new URL("../../docs/scoring/datasets/greptile-50/dataset.json", import.meta.url).pathname)!, "utf8"));
  const j = JSON.parse(readFileSync(`${run}/judged.json`, "utf8")) as { judge: string; judgeCostUsd: number; results: J[] };
  const rep = { judge: j.judge, judgeCostUsd: j.judgeCostUsd, ...summarize(j.results, ds) };
  const base = arg("--baseline");
  const out = base && existsSync(`${base}/report.json`) ? { ...rep, baseline: JSON.parse(readFileSync(`${base}/report.json`, "utf8")).caught } : rep;
  writeFileSync(`${run}/report.json`, JSON.stringify(out, null, 1));
  console.log(JSON.stringify(out, null, 1));
}
