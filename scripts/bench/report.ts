// Catch rate overall / per repo / per severity, cost and latency, next to the published numbers.
// Usage: node scripts/bench/report.ts --run bench-runs/<name> [--baseline bench-runs/<old>]
import { readFileSync, writeFileSync, existsSync } from "node:fs";

interface J { caseId: string; caught: boolean; ok: boolean; costUsd: number; latencyMs: number; findings: number; partial?: boolean }
const arg = (k: string, d?: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2) : 0; };
/** Nearest-rank percentile. */
export const percentile = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]! : 0; };

/** LATENCY-PLAN §8.2 SLO: p50 <= 150 s and p95 <= 300 s, wall clock per PR. */
export const SLO = { p50S: 150, p95S: 300 };

export type Ev = { t?: number; event: string; phase?: string; ms?: number; role?: string; latencyMs?: number; inTok?: number; cachedTok?: number; heapUsed?: number };

/** Per-case latency breakdown from <case>.events.jsonl: phase wall time, LLM calls per role, cache hit ratio, peak heap. */
export function latencyBreakdown(events: Ev[]) {
  const phases: Record<string, number> = {};
  for (const e of events) if (e.event === "phase_end" && e.phase && typeof e.ms === "number") phases[e.phase] = (phases[e.phase] ?? 0) + e.ms;
  const llm = events.filter((e) => e.event === "llm");
  const byRole: Record<string, { calls: number; ms: number }> = {};
  for (const e of llm) { const r = (byRole[e.role ?? "?"] ??= { calls: 0, ms: 0 }); r.calls++; r.ms += e.latencyMs ?? 0; }
  const inTok = llm.reduce((s, e) => s + (e.inTok ?? 0), 0), cached = llm.reduce((s, e) => s + (e.cachedTok ?? 0), 0);
  return { phases, llmCalls: llm.length, byRole, cacheHitRatio: inTok ? cached / inTok : 0, peakHeapMb: Math.max(0, ...events.map((e) => e.heapUsed ?? 0)) / 2 ** 20 };
}

export function latencySummary(perCase: { id: string; latencyMs: number; events: Ev[] }[]) {
  const rows = perCase.map((c) => ({ id: c.id, latencyS: c.latencyMs / 1000, ...latencyBreakdown(c.events) }));
  const lat = rows.map((r) => r.latencyS);
  const phaseNames = [...new Set(rows.flatMap((r) => Object.keys(r.phases)))].sort();
  const p50 = percentile(lat, 50), p95 = percentile(lat, 95);
  return {
    p50S: p50, p95S: p95, maxS: Math.max(0, ...lat), slo: { ...SLO, met: rows.length > 0 && p50 <= SLO.p50S && p95 <= SLO.p95S },
    phases: Object.fromEntries(phaseNames.map((p) => { const v = rows.map((r) => (r.phases[p] ?? 0) / 1000); return [p, { p50S: percentile(v, 50), p95S: percentile(v, 95) }]; })),
    llmCallsPerPr: median(rows.map((r) => r.llmCalls)), cacheHitRatio: median(rows.map((r) => r.cacheHitRatio)),
    cachedTokens: perCase.reduce((s, c) => s + c.events.reduce((x, e) => x + (e.event === "llm" ? e.cachedTok ?? 0 : 0), 0), 0),
    inputTokens: perCase.reduce((s, c) => s + c.events.reduce((x, e) => x + (e.event === "llm" ? e.inTok ?? 0 : 0), 0), 0), peakHeapMb: Math.max(0, ...rows.map((r) => r.peakHeapMb)),
    cases: rows.map(({ id, latencyS, llmCalls, cacheHitRatio, peakHeapMb }) => ({ id, latencyS, llmCalls, cacheHitRatio, peakHeapMb })),
  };
}

export function summarize(results: J[], ds: { cases: { id: string; publishedSeverity: string; published: Record<string, boolean> }[] }) {
  const byId = new Map(ds.cases.map((c) => [c.id, c]));
  const group = (key: (r: J) => string) => {
    const m: Record<string, { caught: number; of: number; greptile: number }> = {};
    for (const r of results) { const k = key(r); const g = (m[k] ??= { caught: 0, of: 0, greptile: 0 }); g.of++; if (r.caught) g.caught++; if (byId.get(r.caseId)?.published.greptile) g.greptile++; }
    return m;
  };
  return {
    caught: results.filter((r) => r.caught).length, of: results.length, failedRuns: results.filter((r) => !r.ok).length,
    // Partial runs (some agent calls failed / budget hit) may under-measure catch rate; listed so they are not silently counted as clean.
    partialCases: results.filter((r) => r.partial).map((r) => ({ id: r.caseId, caught: r.caught })),
    greptileSameCases: results.filter((r) => byId.get(r.caseId)?.published.greptile).length,
    perRepo: group((r) => r.caseId.replace(/-\d+$/, "")), perSeverity: group((r) => byId.get(r.caseId)?.publishedSeverity ?? "?"),
    costUsd: { total: results.reduce((s, r) => s + r.costUsd, 0), medianPerPr: median(results.map((r) => r.costUsd)) },
    latencyS: { median: median(results.map((r) => r.latencyMs)) / 1000, p95: percentile(results.map((r) => r.latencyMs), 95) / 1000, max: Math.max(0, ...results.map((r) => r.latencyMs)) / 1000 },
    commentsPerPr: median(results.map((r) => r.findings)),
    cases: results.map((r) => ({ id: r.caseId, caught: r.caught, greptile: byId.get(r.caseId)?.published.greptile ?? null })),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const run = arg("--run")!;
  const ds = JSON.parse(readFileSync(arg("--dataset", new URL("../../docs/scoring/datasets/greptile-50/dataset.json", import.meta.url).pathname)!, "utf8"));
  const j = JSON.parse(readFileSync(`${run}/judged.json`, "utf8")) as { judge: string; judgeCostUsd: number; results: J[] };
  const results = j.results.map((r) => ({ ...r, partial: r.partial ?? (existsSync(`${run}/${r.caseId}.json`) && !!JSON.parse(readFileSync(`${run}/${r.caseId}.json`, "utf8")).partial) }));
  const events = (id: string): Ev[] => existsSync(`${run}/${id}.events.jsonl`) ? readFileSync(`${run}/${id}.events.jsonl`, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Ev) : [];
  const latency = latencySummary(results.map((r) => ({ id: r.caseId, latencyMs: r.latencyMs, events: events(r.caseId) })));
  // Input-cost saving from prompt caching: cached tokens billed at READ_MULT x the input price instead of 1x.
  const inPrice = Number(arg("--input-usd-per-mtok", "0")), READ_MULT = Number(arg("--cache-read-mult", "0.1"));
  const cacheSavings = { cachedTokens: latency.cachedTokens, inputTokens: latency.inputTokens, hitRatio: latency.inputTokens ? latency.cachedTokens / latency.inputTokens : 0,
    inputCostSavedUsd: (latency.cachedTokens * (1 - READ_MULT) * inPrice) / 1e6, inputCostSavedFraction: latency.inputTokens ? (latency.cachedTokens * (1 - READ_MULT)) / latency.inputTokens : 0 };
  const rep = { judge: j.judge, judgeCostUsd: j.judgeCostUsd, ...summarize(results, ds), cacheSavings, latency: latencySummary(results.map((r) => ({ id: r.caseId, latencyMs: r.latencyMs, events: events(r.caseId) }))) };
  const base = arg("--baseline");
  const out = base && existsSync(`${base}/report.json`) ? { ...rep, baseline: JSON.parse(readFileSync(`${base}/report.json`, "utf8")).caught } : rep;
  writeFileSync(`${run}/report.json`, JSON.stringify(out, null, 1));
  console.log(JSON.stringify(out, null, 1));
}
