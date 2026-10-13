import { z } from "zod";
import type { ScoreMetrics } from "@review/core";
import { Leaderboard, type CaseResult, type Dataset, type LabelledBug, type Rubric, type Submission, type SubmittedFinding } from "./schemas.ts";
import { scoreRun, type scoreSubmission } from "./score.ts";

/** F-beta with beta = 0.5 (precision weighted 2x over recall). Reported next to the score, never folded in. */
export function f05(precision: number, recall: number): number {
  const d = 0.25 * precision + recall;
  return d === 0 ? 0 : (1.25 * precision * recall) / d;
}

/** Feedback tallies for a set of posted findings (from the feedback table). */
export interface FeedbackCounts { findings: number; thumbsUp: number; thumbsDown: number; resolved: number; dismissed: number }

/** Share of findings with feedback that developers accepted (thumbs up or resolved). 0 when no feedback. */
export function acceptanceRate(c: FeedbackCounts): number {
  const voted = c.thumbsUp + c.thumbsDown + c.resolved + c.dismissed;
  return voted === 0 ? 0 : (c.thumbsUp + c.resolved) / voted;
}

/** Share of posted findings that were resolved. 0 when nothing was posted. */
export function resolutionRate(c: FeedbackCounts): number {
  return c.findings === 0 ? 0 : c.resolved / c.findings;
}

export interface RunMetrics extends ScoreMetrics { f05: number; acceptanceRate?: number; resolutionRate?: number }

/** scoreRun plus reporting-only metrics. `score` is the unchanged rubric composite. */
export function runMetrics(dataset: Dataset, results: CaseResult[], rubric: Rubric, feedback?: FeedbackCounts): { metrics: RunMetrics; score: number } {
  const { metrics, score } = scoreRun(dataset, results, rubric);
  return {
    score,
    metrics: { ...metrics, f05: f05(metrics.precision, metrics.recall),
      ...(feedback ? { acceptanceRate: acceptanceRate(feedback), resolutionRate: resolutionRate(feedback) } : {}) },
  };
}

// ---------- judge fallback ----------

export interface Judge { judge(bug: LabelledBug, finding: SubmittedFinding): Promise<{ match: boolean; confidence: number }> }

/** Never matches: keeps the async path identical to the deterministic scorer. */
export const DeterministicJudge: Judge = { judge: async () => ({ match: false, confidence: 1 }) };

/** Minimal structural slice of @review/models ModelRouter (not imported, to keep this package dependency-free). */
export interface JsonRouterLike {
  json<T>(tier: "small" | "medium" | "large", messages: { role: "system" | "user"; content: string }[], schema: z.ZodType<T>,
    opts: { scope: { tenantId: string; reviewId?: string } }): Promise<{ data: T }>;
}

/** LLM judge for near-misses. Sends only labels/titles/locations, never source code. */
const JudgeVerdict = z.object({ match: z.boolean(), confidence: z.number().min(0).max(1) });

export class LlmJudge implements Judge {
  readonly #router: JsonRouterLike;
  readonly #tenantId: string;
  constructor(router: JsonRouterLike, tenantId = "scoring") { this.#router = router; this.#tenantId = tenantId; }
  async judge(bug: LabelledBug, finding: SubmittedFinding) {
    const { data } = await this.#router.json("small", [
      { role: "system", content: "Decide if the reported finding describes the labelled defect. Answer JSON {match, confidence}." },
      { role: "user", content: JSON.stringify({ labelled: { description: bug.description, category: bug.category, location: bug.location },
        reported: { title: finding.title, category: finding.category, location: finding.location } }) },
    ], JudgeVerdict, { scope: { tenantId: this.#tenantId } });
    return data;
  }
}

/**
 * scoreRun with a judge fallback: findings that miss deterministically but sit on the same path within
 * `nearMissLines` of an unmatched bug are referred to the judge (match accepted at confidence >= minConfidence).
 * Metrics/score are then computed by the reference scorer on the judged results, so the formula stays identical.
 */
export async function matchWithJudge(dataset: Dataset, results: CaseResult[], rubric: Rubric, judge: Judge,
  opts: { nearMissLines?: number; minConfidence?: number } = {}) {
  const window = opts.nearMissLines ?? 20, minConf = opts.minConfidence ?? 0.5, tol = rubric.matching.lineTolerance;
  const near = (b: LabelledBug, f: SubmittedFinding, t: number) =>
    b.location.path === f.location.path && f.location.startLine <= b.location.endLine + t && f.location.endLine >= b.location.startLine - t;
  const byCase = new Map(results.map((r) => [r.caseId, r]));
  const judged: CaseResult[] = [];
  let consulted = 0;
  for (const c of dataset.cases) {
    const r = byCase.get(c.id);
    if (!r) continue;
    const unmatched = new Set(c.bugs);
    const findings: SubmittedFinding[] = [];
    // Mirror the reference ordering so deterministic hits are consumed first.
    for (const f of [...r.findings].sort((a, b) => b.confidence - a.confidence)) {
      const span = f.location.endLine - f.location.startLine + 1;
      const ok = span >= 1 && span <= rubric.matching.maxSpanLines;
      const catOk = (b: LabelledBug) => !rubric.matching.requireCategory || b.category === f.category;
      const det = ok ? [...unmatched].find((b) => near(b, f, tol) && catOk(b)) : undefined;
      if (det) { unmatched.delete(det); findings.push(f); continue; }
      const cand = ok ? [...unmatched].find((b) => near(b, f, tol + window) && catOk(b)) : undefined;
      if (cand) {
        consulted++;
        const v = await judge.judge(cand, f);
        // Snap an accepted near-miss onto the label so the reference scorer counts it as a TP.
        if (v.match && v.confidence >= minConf) { unmatched.delete(cand); findings.push({ ...f, location: cand.location }); continue; }
      }
      findings.push(f);
    }
    judged.push({ ...r, findings });
  }
  return { ...scoreRun(dataset, judged, rubric), judgeCalls: consulted };
}

// ---------- leaderboard ----------

export interface LeaderboardInput { submission: Submission; result: ReturnType<typeof scoreSubmission>; path: string; verified: boolean }

const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / Math.max(xs.length, 1);

/** Rank by score desc, then std dev asc, then system name. All entries must share rubric + dataset versions. */
export function buildLeaderboard(entries: LeaderboardInput[], generatedAt = new Date().toISOString()): Leaderboard {
  const first = entries[0];
  const rubricVersion = first?.submission.rubricVersion ?? "1.0.0", datasetVersion = first?.submission.datasetVersion ?? "";
  for (const e of entries) {
    if (e.submission.rubricVersion !== rubricVersion || e.submission.datasetVersion !== datasetVersion)
      throw new Error(`leaderboard mixes versions: ${e.path}`);
  }
  const rows = entries.map((e) => {
    const m = (k: keyof ScoreMetrics) => mean(e.result.runs.map((r) => r.metrics[k]));
    return { system: e.submission.system, rubricVersion, datasetVersion, score: e.result.score, scoreStdDev: e.result.scoreStdDev,
      precision: m("precision"), recall: m("recall"), severityWeightedRecall: m("severityWeightedRecall"),
      falsePositivesPerPr: m("falsePositivesPerPr"), latencyP50Ms: m("latencyP50Ms"), costPerPrUsd: m("costPerPrUsd"),
      verified: e.verified, submissionPath: e.path };
  }).sort((a, b) => b.score - a.score || a.scoreStdDev - b.scoreStdDev || a.system.name.localeCompare(b.system.name));
  return Leaderboard.parse({ rubricVersion, datasetVersion, generatedAt, entries: rows.map((r, i) => ({ rank: i + 1, ...r })) });
}

// ---------- regression gate ----------

export interface GateReport { rubricVersion?: string; score: number; metrics: Pick<ScoreMetrics, "severityWeightedRecall" | "precision"> }

export function regressionGate(baseline: GateReport, candidate: GateReport,
  opts: { maxScoreDrop?: number; maxSwrDrop?: number; maxPrecisionDrop?: number } = {}): { pass: boolean; reasons: string[] } {
  const { maxScoreDrop = 1, maxSwrDrop = 0.02, maxPrecisionDrop = 0.02 } = opts;
  const reasons: string[] = [];
  if (baseline.rubricVersion && candidate.rubricVersion && baseline.rubricVersion !== candidate.rubricVersion)
    reasons.push(`rubric mismatch: ${baseline.rubricVersion} != ${candidate.rubricVersion}`);
  const drop = (name: string, b: number, c: number, max: number) => {
    if (b - c > max) reasons.push(`${name} dropped ${(b - c).toFixed(4)} (> ${max}): ${b.toFixed(4)} -> ${c.toFixed(4)}`);
  };
  drop("score", baseline.score, candidate.score, maxScoreDrop);
  drop("severityWeightedRecall", baseline.metrics.severityWeightedRecall, candidate.metrics.severityWeightedRecall, maxSwrDrop);
  drop("precision", baseline.metrics.precision, candidate.metrics.precision, maxPrecisionDrop);
  return { pass: reasons.length === 0, reasons };
}
