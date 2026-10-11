import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Dataset, Rubric, Submission, scoreRun, scoreSubmission, ScoringClient, Leaderboard } from "../src/index.ts";

const docs = new URL("../../../docs/scoring/", import.meta.url);
const rubric = Rubric.parse(JSON.parse(readFileSync(new URL("rubric/rubric.v1.0.0.json", docs), "utf8")));
const dataset = Dataset.parse(JSON.parse(readFileSync(new URL("datasets/sample-0.1/dataset.json", docs), "utf8")));
const sample = Submission.parse(JSON.parse(readFileSync(new URL("submissions/example/submission.json", docs), "utf8")));
Leaderboard.parse(JSON.parse(readFileSync(new URL("leaderboard/leaderboard.json", docs), "utf8")));

const perfect = dataset.cases.map((c) => ({ caseId: c.id, latencyMs: 1000, costUsd: 0.01,
  findings: c.bugs.map((b) => ({ category: b.category, severity: b.severity, location: b.location, title: b.id, confidence: 1 })) }));

test("perfect predictions score 100", () => {
  const r = scoreRun(dataset, perfect, rubric);
  assert.equal(r.metrics.precision, 1); assert.equal(r.metrics.recall, 1);
  assert.equal(Math.round(r.score), 100);
});

test("empty predictions: recall 0, no false positives", () => {
  const r = scoreRun(dataset, dataset.cases.map((c) => ({ caseId: c.id, findings: [], latencyMs: 1, costUsd: 0 })), rubric);
  assert.equal(r.metrics.recall, 0); assert.equal(r.metrics.falsePositivesPerPr, 0);
  assert.ok(r.score < 60);
});

test("a finding cannot match the same bug twice and wrong file is FP", () => {
  const c = dataset.cases.find((x) => x.bugs.length > 0)!;
  const b = c.bugs[0]!;
  const dup = { category: b.category, severity: b.severity, location: b.location, title: "d", confidence: 0.9 };
  const res = [{ caseId: c.id, latencyMs: 1, costUsd: 0, findings: [dup, dup, { ...dup, location: { ...b.location, path: "elsewhere.ts" } }] }];
  const r = scoreRun({ ...dataset, cases: [c] }, res, rubric);
  assert.equal(r.metrics.falsePositivesPerPr, 2);
});

test("scoreSubmission validates versions and run count; sample submission scores", () => {
  const out = scoreSubmission(dataset, sample, rubric);
  assert.ok(out.score >= 0 && out.score <= 100);
  assert.throws(() => scoreSubmission(dataset, { ...sample, rubricVersion: "9.9.9" }, rubric), /rubric mismatch/);
  assert.throws(() => scoreSubmission(dataset, { ...sample, runs: sample.runs.slice(0, 1) }, rubric), /need >=/);
});

test("ScoringClient fetches and validates rubric from the configured base", async () => {
  const seen: string[] = [];
  const f = (async (u: string | URL | Request) => { seen.push(String(u)); return Response.json(rubric); }) as typeof fetch;
  const r = await new ScoringClient({ baseUrl: "https://example.test/repo/", fetch: f }).rubric();
  assert.equal(r.version, "1.0.0");
  assert.deepEqual(seen, ["https://example.test/repo/rubric/rubric.v1.0.0.json"]);
});

test("whole-file ranges cannot blanket-match bugs (span > maxSpanLines counts as FP)", () => {
  const blanket = dataset.cases.map((c) => ({ caseId: c.id, latencyMs: 1, costUsd: 0,
    findings: [...new Set(c.bugs.map((b) => b.location.path))].map((path) => ({
      category: "bug" as const, severity: "high" as const, location: { path, startLine: 1, endLine: 1_000_000_000 }, title: "x", confidence: 1 })) }));
  const r = scoreRun(dataset, blanket, rubric);
  assert.equal(r.metrics.recall, 0);
  assert.equal(r.score, 0);
  assert.throws(() => Submission.parse({ ...sample, runs: [{ results: [{ caseId: "x", latencyMs: 1, costUsd: 0,
    findings: [{ category: "bug", severity: "low", location: { path: "a.ts", startLine: 9, endLine: 2 }, title: "t" }] }] }] }), /endLine/);
});

test("empty submission scores 0 (cannot bank precision/FP credit by staying silent)", () => {
  const empty = dataset.cases.map((c) => ({ caseId: c.id, latencyMs: 1, costUsd: 0, findings: [] }));
  const r = scoreRun(dataset, empty, rubric);
  assert.equal(r.metrics.precision, 0);
  assert.equal(r.score, 0);
});

