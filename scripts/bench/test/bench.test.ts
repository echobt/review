import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { bestComment, terms } from "../extract.ts";
import { keywordHit, locationHit } from "../judge.ts";
import { latencySummary, percentile, summarize } from "../report.ts";

const ds = JSON.parse(readFileSync(new URL("../../../docs/scoring/datasets/greptile-50/dataset.json", import.meta.url), "utf8"));
const table = JSON.parse(readFileSync(new URL("../cases.json", import.meta.url), "utf8"));

test("dataset: 50 cases, 10 per repo, pinned SHAs, published Greptile total 41/50 and 8/10 on Sentry", () => {
  expect(ds.cases).toHaveLength(50);
  for (const r of ["sentry", "calcom", "grafana", "keycloak", "discourse"]) expect(ds.cases.filter((c: { id: string }) => c.id.startsWith(r + "-"))).toHaveLength(10);
  for (const c of ds.cases) { expect(c.baseSha).toMatch(/^[0-9a-f]{40}$/); expect(c.headSha).toMatch(/^[0-9a-f]{40}$/); }
  expect(ds.cases.filter((c: { published: { greptile: boolean } }) => c.published.greptile)).toHaveLength(41);
  expect(ds.cases.filter((c: { id: string; published: { greptile: boolean } }) => c.id.startsWith("sentry") && c.published.greptile)).toHaveLength(8);
  expect(ds.cases.filter((c: { id: string; labelSource: string }) => c.id.startsWith("sentry")).every((c: { labelSource: string }) => c.labelSource === "human")).toBe(true);
  expect(table.cases).toHaveLength(50);
});

test("label auto-pick prefers the comment overlapping the bug description", () => {
  expect(terms("Inconsistent metric tagging with 'shard' and 'shards'")).toContain("shards");
  const best = bestComment("sample_rate = 0.0 is falsy", [
    { tool: "greptile", path: "a.py", line: 1, body: "unused import" },
    { tool: "greptile", path: "f.py", line: 353, body: "client_sample_rate 0.0 is falsy here" },
  ]);
  expect(best?.line).toBe(353);
});

test("judge location rule mirrors the published rule: +/-3 lines, <= 10-line span, acceptAlso sites", () => {
  const bug = { description: "shard vs shards", location: { path: "f.py", startLine: 199, endLine: 199 }, acceptAlso: [{ path: "f.py", startLine: 185, endLine: 185 }], keyTerms: ["shards"] };
  const f = (s: number, e = s, path = "f.py") => ({ title: "Tag key 'shards' differs", body: "", location: { path, startLine: s, endLine: e } });
  expect(locationHit(bug, f(202))).toBe(true);
  expect(locationHit(bug, f(203))).toBe(false);
  expect(locationHit(bug, f(186))).toBe(true);
  expect(locationHit(bug, f(190, 205))).toBe(false); // 16-line span
  expect(locationHit(bug, f(199, 199, "g.py"))).toBe(false);
  expect(keywordHit(bug, f(199))).toBe(true);
});

test("report: catch rate per repo/severity, cost and latency medians", () => {
  const rep = summarize([
    { caseId: "sentry-03", caught: true, ok: true, costUsd: 0.2, latencyMs: 10_000, findings: 3 },
    { caseId: "sentry-02", caught: false, ok: true, costUsd: 0.4, latencyMs: 30_000, findings: 5 },
  ], ds);
  expect(rep).toMatchObject({ caught: 1, of: 2, perRepo: { sentry: { caught: 1, of: 2, greptile: 1 } }, perSeverity: { low: { caught: 1, of: 1 } }, costUsd: { medianPerPr: expect.closeTo(0.3, 5) }, latencyS: { median: 20, p95: 30 } });
});

test("latency report: nearest-rank p50/p95, per-phase breakdown, LLM calls, cache hit ratio, peak heap, SLO verdict", () => {
  expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50)).toBe(5);
  expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10);
  const ev = (planMs: number, huntMs: number) => [
    { event: "phase_end", phase: "plan", ms: planMs }, { event: "phase_end", phase: "hunt", ms: huntMs }, { event: "phase_end", phase: "hunt", ms: huntMs },
    { event: "llm", role: "hunter", latencyMs: 900, inTok: 1000, cachedTok: 800 }, { event: "llm", role: "planner", latencyMs: 100, inTok: 1000, cachedTok: 0 },
    { event: "heap", heapUsed: 512 * 2 ** 20 },
  ];
  const fast = latencySummary([{ id: "a", latencyMs: 100_000, events: ev(1000, 2000) }, { id: "b", latencyMs: 140_000, events: ev(3000, 4000) }]);
  expect(fast).toMatchObject({ p50S: 100, p95S: 140, slo: { met: true }, llmCallsPerPr: 2, cacheHitRatio: 0.4, peakHeapMb: 512,
    phases: { plan: { p50S: 1, p95S: 3 }, hunt: { p50S: 4, p95S: 8 } } });
  expect(latencySummary([{ id: "a", latencyMs: 1_380_000, events: [] }]).slo.met).toBe(false);
  expect(latencySummary([]).slo.met).toBe(false);
});
