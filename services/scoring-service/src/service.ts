import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ScoreReport, type Finding, type Message } from "@review/core";
import { completeScoreJob, getReview, withTenant, type Database } from "@review/db";
import {
  Dataset, Rubric, Submission, ScoringClient, scoreRun, scoreSubmission,
  type CaseResult, type DatasetCase, type SubmittedFinding,
} from "@review/scoring-client";

export type ScoringSource = { dir: string } | { client: ScoringClient };

/** Load rubric + dataset pinned by version; a rubric whose declared version differs is rejected. */
export async function loadPinned(source: ScoringSource, rubricVersion: string, datasetVersion: string): Promise<{ rubric: Rubric; dataset: Dataset }> {
  const [rubric, dataset] = "dir" in source
    ? await Promise.all([
      readFile(join(source.dir, "rubric", `rubric.v${rubricVersion}.json`), "utf8").then((s) => Rubric.parse(JSON.parse(s))),
      readFile(join(source.dir, "datasets", datasetVersion, "dataset.json"), "utf8").then((s) => Dataset.parse(JSON.parse(s))),
    ])
    : await Promise.all([source.client.rubric(rubricVersion), source.client.dataset(datasetVersion)]);
  if (rubric.version !== rubricVersion) throw new Error(`rubric version mismatch: wanted ${rubricVersion}, got ${rubric.version}`);
  if (dataset.version !== datasetVersion) throw new Error(`dataset version mismatch: wanted ${datasetVersion}, got ${dataset.version}`);
  return { rubric, dataset };
}

export const toSubmitted = (f: Finding): SubmittedFinding =>
  ({ category: f.category, severity: f.severity, location: f.location, title: f.title, confidence: f.confidence });

export interface ScoringServiceOptions { db?: Database; source: ScoringSource; datasetVersion: string; system?: { name: string; version: string; model?: string } }

export class ScoringService {
  readonly #opts: ScoringServiceOptions;
  readonly #cache = new Map<string, Promise<{ rubric: Rubric; dataset: Dataset }>>();
  constructor(opts: ScoringServiceOptions) { this.#opts = opts; }

  load(rubricVersion: string) {
    let p = this.#cache.get(rubricVersion);
    if (!p) {
      p = loadPinned(this.#opts.source, rubricVersion, this.#opts.datasetVersion);
      p.catch(() => this.#cache.delete(rubricVersion));
      this.#cache.set(rubricVersion, p);
    }
    return p;
  }

  /** Run `reviewer` over every case `runs` times (sequentially: deterministic order, bounded spend). */
  async replay(dataset: Dataset, reviewer: (c: DatasetCase) => Promise<CaseResult>, runs = 3,
    meta: { rubricVersion: string; system?: Submission["system"]; harness?: Submission["harness"] } = { rubricVersion: "1.0.0" }): Promise<Submission> {
    const out: Submission["runs"] = [];
    for (let i = 0; i < runs; i++) {
      const results: CaseResult[] = [];
      for (const c of dataset.cases) results.push({ ...(await reviewer(c)), caseId: c.id });
      out.push({ results });
    }
    return Submission.parse({ system: meta.system ?? this.#opts.system ?? { name: "review-platform", version: "0.1.0" },
      rubricVersion: meta.rubricVersion, datasetVersion: dataset.version, runs: out,
      harness: meta.harness ?? { commit: "local", command: "scoring-service replay" } });
  }

  /** Replay + score into a core ScoreReport (mean over runs, population std dev). */
  async replayReport(rubricVersion: string, reviewer: (c: DatasetCase) => Promise<CaseResult>, runs?: number): Promise<ScoreReport> {
    const { rubric, dataset } = await this.load(rubricVersion);
    const sub = await this.replay(dataset, reviewer, runs ?? rubric.minRuns, { rubricVersion });
    const r = scoreSubmission(dataset, sub, rubric);
    const avg = (k: keyof ScoreReport["metrics"]) => r.runs.reduce((s, x) => s + x.metrics[k], 0) / r.runs.length;
    const keys = Object.keys(r.runs[0]!.metrics) as (keyof ScoreReport["metrics"])[];
    return ScoreReport.parse({ id: randomUUID(), rubricVersion, datasetVersion: dataset.version, system: sub.system,
      metrics: Object.fromEntries(keys.map((k) => [k, avg(k)])), score: r.score, runs: r.runs.length, scoreStdDev: r.scoreStdDev,
      createdAt: new Date().toISOString() });
  }

  /** score.requested: score one stored review against one labelled case and persist the report (or the error). */
  async scoreReview(msg: Message<"score.requested">): Promise<ScoreReport | undefined> {
    const db = this.#opts.db;
    if (!db) throw new Error("scoreReview needs a database");
    const { reviewId, datasetCaseId, rubricVersion } = msg.payload;
    const scoreId = msg.payload.scoreId ?? randomUUID();
    let report: ScoreReport | undefined, error: string | undefined;
    try {
      const { rubric, dataset } = await this.load(rubricVersion);
      const kase = dataset.cases.find((c) => c.id === datasetCaseId);
      if (!kase) throw new Error(`unknown dataset case ${datasetCaseId} in ${dataset.version}`);
      const review = await withTenant(db, msg.tenantId, (sql) => getReview(sql, reviewId));
      if (!review) throw new Error(`review ${reviewId} not found`);
      const one = { version: dataset.version, cases: [kase] };
      const { metrics, score } = scoreRun(one, [{ caseId: kase.id, findings: review.findings.map(toSubmitted),
        latencyMs: review.usage?.latencyMs ?? 0, costUsd: review.usage?.costUsd ?? 0 }], rubric);
      report = ScoreReport.parse({ id: scoreId, rubricVersion, datasetVersion: dataset.version,
        system: this.#opts.system ?? { name: "review-platform", version: "0.1.0" }, metrics, score, runs: 1, scoreStdDev: 0,
        createdAt: new Date().toISOString() });
    } catch (e) {
      error = (e as Error).message;
    }
    await withTenant(db, msg.tenantId, (sql) => completeScoreJob(sql, msg.tenantId, scoreId,
      { reviewId, datasetCaseId, ...(report ? { report } : { error: error ?? "unknown" }) }));
    return report;
  }
}
