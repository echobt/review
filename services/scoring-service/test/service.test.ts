import { test, afterAll } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseMessage, ScoreReport } from "@review/core";
import { createReview, getScoreJob, createScoreJob, insertFindings, withTenant } from "@review/db";
import { createTestDatabase } from "@review/db/testing";
import { Leaderboard, ScoringClient, scoreRun } from "@review/scoring-client";
import { ScoringService, makeHandler, loadPinned, gate, exportLeaderboard } from "../src/index.ts";

const dir = fileURLToPath(new URL("../../../docs/scoring/", import.meta.url));
const { db, newTenant } = await createTestDatabase();
afterAll(() => db.close());

test("loadPinned enforces exact rubric version from dir and remote client", async () => {
  const { rubric, dataset } = await loadPinned({ dir }, "1.0.0", "sample-0.1");
  assert.equal(rubric.version, "1.0.0"); assert.equal(dataset.version, "sample-0.1");
  await assert.rejects(loadPinned({ dir }, "9.9.9", "sample-0.1"));
  const lying = new ScoringClient({ baseUrl: "https://x.test", fetch: (async (u: string | URL | Request) =>
    Response.json(String(u).includes("rubric") ? { ...rubric, version: "1.0.1" } : dataset)) as typeof fetch });
  await assert.rejects(loadPinned({ client: lying }, "1.0.0", "sample-0.1"), /rubric version mismatch/);
});

test("replay produces minRuns runs and scores deterministically", async () => {
  const svc = new ScoringService({ source: { dir }, datasetVersion: "sample-0.1" });
  const { rubric, dataset } = await svc.load("1.0.0");
  const reviewer = async (c: (typeof dataset.cases)[number]) => ({ caseId: c.id, latencyMs: 10, costUsd: 0.001,
    findings: c.bugs.slice(0, 1).map((b) => ({ category: b.category, severity: b.severity, location: b.location, title: b.id, confidence: 1 })) });
  const sub = await svc.replay(dataset, reviewer, rubric.minRuns);
  assert.equal(sub.runs.length, rubric.minRuns);
  const a = await svc.replayReport("1.0.0", reviewer), b = await svc.replayReport("1.0.0", reviewer);
  assert.equal(a.runs, 3); assert.equal(a.score, b.score); assert.equal(a.scoreStdDev, 0);
  assert.equal(a.score, scoreRun(dataset, sub.runs[0]!.results, rubric).score);
});

test("end-to-end on PGlite: review with findings -> score.requested -> completed ScoreReport", async () => {
  const tenantId = await newTenant();
  const { dataset, rubric } = await loadPinned({ dir }, "1.0.0", "sample-0.1");
  const kase = dataset.cases.find((c) => c.bugs.length > 0)!;
  const bug = kase.bugs[0]!;
  const scoreId = await withTenant(db, tenantId, async (sql) => {
    const r = await createReview(sql, tenantId, { repositoryId: "repo-1" });
    await insertFindings(sql, tenantId, [
      { fingerprint: "f1", finding: { id: "f1", reviewId: r.id, category: bug.category, severity: bug.severity, title: "hit", body: "", location: bug.location, related: [], confidence: 0.9, source: "llm", cwe: [] } },
      { fingerprint: "f2", finding: { id: "f2", reviewId: r.id, category: "bug", severity: "low", title: "noise", body: "", location: { path: "zzz.ts", startLine: 1, endLine: 1 }, related: [], confidence: 0.2, source: "llm", cwe: [] } },
    ]);
    return (await createScoreJob(sql, tenantId, { reviewId: r.id, datasetCaseId: kase.id, rubricVersion: "1.0.0" })).id;
  });
  const reviewId = (await withTenant(db, tenantId, (sql) => getScoreJob(sql, scoreId)))!.reviewId;
  const handle = makeHandler(new ScoringService({ db, source: { dir }, datasetVersion: "sample-0.1" }));
  await handle(parseMessage("score.requested", { messageId: "7f1d2c9e-8a8b-4c4e-9d55-1d0f3b9a2c11", tenantId, createdAt: "2026-10-11T00:00:00Z",
    payload: { scoreId, reviewId, datasetCaseId: kase.id, rubricVersion: "1.0.0" } }));
  const job = (await withTenant(db, tenantId, (sql) => getScoreJob(sql, scoreId)))!;
  assert.equal(job.status, "completed");
  const report = ScoreReport.parse(job.report);
  assert.equal(report.metrics.precision, 0.5);
  assert.equal(report.metrics.recall, 1 / kase.bugs.length);
  assert.ok(report.score > 0 && report.score <= 100);
  assert.equal(rubric.version, report.rubricVersion);

  await handle(parseMessage("score.requested", { messageId: "7f1d2c9e-8a8b-4c4e-9d55-1d0f3b9a2c12", tenantId, createdAt: "2026-10-11T00:00:00Z",
    payload: { scoreId: "bad-1", reviewId, datasetCaseId: "nope", rubricVersion: "1.0.0" } }));
  const bad = (await withTenant(db, tenantId, (sql) => getScoreJob(sql, "bad-1")))!;
  assert.equal(bad.status, "failed"); assert.match(bad.error!, /unknown dataset case/);
});

const report = (score: number, swr: number, precision: number) => ScoreReport.parse({ id: "x", rubricVersion: "1.0.0", datasetVersion: "sample-0.1",
  system: { name: "s", version: "1" }, score, runs: 3, scoreStdDev: 0, createdAt: "2026-10-11T00:00:00Z",
  metrics: { precision, recall: 0.5, f1: 0.5, severityWeightedRecall: swr, falsePositivesPerPr: 0, latencyP50Ms: 1, latencyP95Ms: 1, costPerPrUsd: 0 } });

test("gate CLI: exit 0 within thresholds, exit 1 on regression", () => {
  const t = mkdtempSync(join(tmpdir(), "gate-"));
  const a = join(t, "a.json"), b = join(t, "b.json"), c = join(t, "c.json");
  writeFileSync(a, JSON.stringify(report(60, 0.7, 0.6))); writeFileSync(b, JSON.stringify(report(59.5, 0.7, 0.6))); writeFileSync(c, JSON.stringify(report(50, 0.5, 0.6)));
  assert.equal(gate(["--baseline", a, "--candidate", b]).pass, true);
  const cli = fileURLToPath(new URL("../src/gate.ts", import.meta.url));
  execFileSync(process.execPath, [cli, "--baseline", a, "--candidate", b]);
  assert.throws(() => execFileSync(process.execPath, [cli, "--baseline", a, "--candidate", c], { stdio: "pipe" }), (e: { status: number }) => e.status === 1);
});

test("leaderboard export writes JSON that validates", async () => {
  const out = join(mkdtempSync(join(tmpdir(), "lb-")), "leaderboard.json");
  const lb = await exportLeaderboard(["--dir", dir, "--out", out, "--generated-at", "2026-10-11T00:00:00Z"]);
  const parsed = Leaderboard.parse(JSON.parse(readFileSync(out, "utf8")));
  assert.deepEqual(parsed, lb);
  assert.equal(parsed.entries[0]?.submissionPath, "submissions/example/submission.json");
  assert.equal(parsed.entries[0]?.rank, 1);
});
