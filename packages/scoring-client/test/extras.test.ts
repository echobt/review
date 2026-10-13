import { test } from "vitest";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  Dataset, Leaderboard, Rubric, Submission, scoreRun, scoreSubmission, f05, acceptanceRate, resolutionRate, runMetrics,
  matchWithJudge, DeterministicJudge, LlmJudge, buildLeaderboard, regressionGate, type Judge, type CaseResult, type JsonRouterLike,
} from "../src/index.ts";

const docs = new URL("../../../docs/scoring/", import.meta.url);
const rubric = Rubric.parse(JSON.parse(readFileSync(new URL("rubric/rubric.v1.0.0.json", docs), "utf8")));
const lbSchema = JSON.parse(readFileSync(new URL("schema/leaderboard.schema.json", docs), "utf8"));

const sha = (c: string) => c.repeat(40);
const ds = Dataset.parse({ version: "t-1", cases: [
  { id: "A", repo: "https://x.test/r", baseSha: sha("a"), headSha: sha("b"), language: "ts", license: "MIT", provenance: "injected", bugs: [
    { id: "b1", category: "bug", severity: "high", location: { path: "a.ts", startLine: 10, endLine: 12 }, description: "d" },
    { id: "b2", category: "bug", severity: "low", location: { path: "a.ts", startLine: 50, endLine: 50 }, description: "d" }] },
  { id: "B", repo: "https://x.test/r", baseSha: sha("a"), headSha: sha("b"), language: "ts", license: "MIT", provenance: "injected", bugs: [] },
] });
const f = (path: string, s: number, e = s, confidence = 1) => ({ category: "bug" as const, severity: "high" as const, location: { path, startLine: s, endLine: e }, title: "t", confidence });
const results: CaseResult[] = [
  { caseId: "A", findings: [f("a.ts", 11), f("z.ts", 1)], latencyMs: 100, costUsd: 0.02 },
  { caseId: "B", findings: [f("b.ts", 5)], latencyMs: 300, costUsd: 0.04 },
];

test("hand-computed metrics: TP=1 FP=2 FN=1, SWR weights, geometric composite", () => {
  const { metrics: m, score } = runMetrics(ds, results, rubric, { findings: 4, thumbsUp: 1, thumbsDown: 1, resolved: 1, dismissed: 1 });
  assert.equal(m.precision, 1 / 3);
  assert.equal(m.recall, 1 / 2);
  assert.equal(m.severityWeightedRecall, 4 / 5);
  assert.equal(m.falsePositivesPerPr, 1);
  assert.ok(Math.abs(m.f05 - 5 / 14) < 1e-12);
  assert.ok(Math.abs(score - 100 * 0.8 ** 0.5 * (1 / 3) ** 0.3 * (2 / 3) ** 0.2) < 1e-9);
  assert.equal(score, scoreRun(ds, results, rubric).score);
  assert.equal(m.latencyP50Ms, 300); assert.equal(m.costPerPrUsd, 0.03);
  assert.equal(m.acceptanceRate, 0.5); assert.equal(m.resolutionRate, 0.25);
});

test("FP/PR at cap zeroes the score; f05 and rate edges", () => {
  const flood = [{ caseId: "A", findings: [f("a.ts", 11), ...[1, 2, 3, 4, 5, 6].map((i) => f("n.ts", i))], latencyMs: 1, costUsd: 0 }];
  assert.equal(scoreRun(ds, flood, rubric).score, 0);
  assert.equal(f05(0, 0), 0); assert.equal(f05(1, 1), 1);
  assert.equal(acceptanceRate({ findings: 0, thumbsUp: 0, thumbsDown: 0, resolved: 0, dismissed: 0 }), 0);
  assert.equal(resolutionRate({ findings: 0, thumbsUp: 0, thumbsDown: 0, resolved: 0, dismissed: 0 }), 0);
});

test("judge is consulted only for same-path near-misses and can turn them into TPs", async () => {
  const seen: string[] = [];
  const yes: Judge = { judge: async (b, x) => { seen.push(`${b.id}@${x.location.path}:${x.location.startLine}`); return { match: true, confidence: 0.9 }; } };
  const res = [{ caseId: "A", findings: [f("a.ts", 11), f("a.ts", 20, 20, 0.5), f("other.ts", 11, 11, 0.4), f("a.ts", 400, 400, 0.3)], latencyMs: 1, costUsd: 0 }];
  const j = await matchWithJudge(ds, res, rubric, yes);
  assert.deepEqual(seen, []); // b1 hit deterministically; 20 is near b1 only, which is taken; b2 at 50 is 30 lines away (>3+20)
  const res2 = [{ caseId: "A", findings: [f("a.ts", 20), f("a.ts", 60, 60, 0.5)], latencyMs: 1, costUsd: 0 }];
  const j2 = await matchWithJudge(ds, res2, rubric, yes);
  assert.deepEqual(seen, ["b1@a.ts:20", "b2@a.ts:60"]);
  assert.equal(j2.metrics.recall, 1); assert.equal(j2.judgeCalls, 2);
  const det = await matchWithJudge(ds, res2, rubric, DeterministicJudge);
  assert.deepEqual(det.metrics, scoreRun(ds, res2, rubric).metrics);
  assert.equal(j.metrics.precision, scoreRun(ds, res, rubric).metrics.precision);
});

test("LlmJudge uses the structural router and parses its verdict", async () => {
  const calls: unknown[] = [];
  const router: JsonRouterLike = { json: async (tier, msgs, schema) => { calls.push(tier, msgs.length); return { data: schema.parse({ match: true, confidence: 0.7 }) }; } };
  const v = await new LlmJudge(router).judge(ds.cases[0]!.bugs[0]!, f("a.ts", 20));
  assert.deepEqual(v, { match: true, confidence: 0.7 });
  assert.deepEqual(calls, ["small", 2]);
});

const sub = (name: string, runs: CaseResult[][]) => Submission.parse({ system: { name, version: "1" }, rubricVersion: "1.0.0", datasetVersion: "t-1",
  runs: runs.map((results) => ({ results })), harness: { commit: "c", command: "x" } });
const perfect: CaseResult[] = [{ caseId: "A", findings: [f("a.ts", 11), f("a.ts", 50)], latencyMs: 1, costUsd: 0 }, { caseId: "B", findings: [], latencyMs: 1, costUsd: 0 }];

test("leaderboard: score desc, std dev asc, then name; conforms to JSON schema", () => {
  const mk = (s: Submission) => ({ submission: s, result: scoreSubmission(ds, s, rubric), path: `submissions/${s.system.name}`, verified: false });
  const lb = buildLeaderboard([
    mk(sub("mid", [results, results, results])),
    mk(sub("zeta", [perfect, perfect, perfect])),
    mk(sub("alpha", [perfect, perfect, perfect])),
    mk(sub("noisy", [perfect, results, perfect])),
  ], "2026-10-11T00:00:00Z");
  assert.deepEqual(lb.entries.map((e) => [e.rank, e.system.name]), [[1, "alpha"], [2, "zeta"], [3, "noisy"], [4, "mid"]]);
  Leaderboard.parse(JSON.parse(JSON.stringify(lb)));
  for (const k of lbSchema.required) assert.ok(k in lb, k);
  for (const e of lb.entries) for (const k of lbSchema.properties.entries.items.required) assert.ok(k in e, k);
  assert.ok(!Number.isNaN(Date.parse(lb.generatedAt)));
});

test("regression gate passes within thresholds and fails with reasons", () => {
  const base = { rubricVersion: "1.0.0", score: 60, metrics: { severityWeightedRecall: 0.7, precision: 0.6 } };
  assert.deepEqual(regressionGate(base, { ...base, score: 59.5 }), { pass: true, reasons: [] });
  const r = regressionGate(base, { rubricVersion: "1.0.0", score: 58, metrics: { severityWeightedRecall: 0.6, precision: 0.6 } }, { maxScoreDrop: 1, maxSwrDrop: 0.05 });
  assert.equal(r.pass, false);
  assert.equal(r.reasons.length, 2);
  assert.match(r.reasons[0]!, /^score/); assert.match(r.reasons[1]!, /^severityWeightedRecall/);
});
