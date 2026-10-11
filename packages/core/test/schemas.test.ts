import { test } from "node:test";
import assert from "node:assert/strict";
import { Finding, Location, ScoreReport } from "../src/index.ts";

const finding = {
  id: "f1", reviewId: "r1", category: "bug", severity: "high", title: "Null deref",
  body: "x may be undefined", location: { path: "a.ts", startLine: 3, endLine: 4 },
  confidence: 0.8, source: "llm",
};

test("Finding parses valid input and applies defaults", () => {
  const f = Finding.parse(finding);
  assert.deepEqual(f.related, []);
  assert.deepEqual(f.cwe, []);
});

test("Finding rejects confidence > 1 and unknown severity", () => {
  assert.equal(Finding.safeParse({ ...finding, confidence: 1.5 }).success, false);
  assert.equal(Finding.safeParse({ ...finding, severity: "blocker" }).success, false);
});

test("Location rejects inverted range", () => {
  assert.equal(Location.safeParse({ path: "a", startLine: 5, endLine: 2 }).success, false);
});

test("ScoreReport requires semver rubric", () => {
  const base = {
    id: "s", rubricVersion: "1.0.0", datasetVersion: "2026.10", system: { name: "x", version: "1" },
    metrics: { precision: 1, recall: 1, f1: 1, severityWeightedRecall: 1, falsePositivesPerPr: 0, latencyP50Ms: 1, latencyP95Ms: 1, costPerPrUsd: 0 },
    score: 90, runs: 3, scoreStdDev: 0.5, createdAt: "2026-10-11T00:00:00Z",
  };
  assert.equal(ScoreReport.safeParse(base).success, true);
  assert.equal(ScoreReport.safeParse({ ...base, rubricVersion: "v1" }).success, false);
});
