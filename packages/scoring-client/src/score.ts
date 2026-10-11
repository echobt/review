import type { ScoreMetrics } from "@review/core";
import type { CaseResult, Dataset, LabelledBug, Rubric, Submission, SubmittedFinding } from "./schemas.ts";

const overlaps = (a: LabelledBug["location"], b: SubmittedFinding["location"], tol: number) =>
  a.path === b.path && b.startLine <= a.endLine + tol && b.endLine >= a.startLine - tol;

interface RunScore { metrics: ScoreMetrics; score: number }

/** Reference scorer for one run. Greedy one-to-one matching by descending confidence. */
export function scoreRun(dataset: Dataset, results: CaseResult[], rubric: Rubric): RunScore {
  const byCase = new Map(results.map((r) => [r.caseId, r]));
  let tp = 0, fp = 0, labels = 0, wMatched = 0, wTotal = 0;
  const lat: number[] = []; let cost = 0;
  for (const c of dataset.cases) {
    const r = byCase.get(c.id);
    lat.push(r?.latencyMs ?? 0); cost += r?.costUsd ?? 0;
    labels += c.bugs.length;
    for (const b of c.bugs) wTotal += rubric.severityWeights[b.severity] ?? 0;
    const unmatched = new Set(c.bugs);
    for (const f of [...(r?.findings ?? [])].sort((a, b) => b.confidence - a.confidence)) {
      const hit = [...unmatched].find((b) => overlaps(b.location, f.location, rubric.matching.lineTolerance)
        && (!rubric.matching.requireCategory || b.category === f.category));
      if (hit) { unmatched.delete(hit); tp++; wMatched += rubric.severityWeights[hit.severity] ?? 0; } else fp++;
    }
  }
  const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
  const recall = labels === 0 ? 1 : tp / labels;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  const severityWeightedRecall = wTotal === 0 ? 1 : wMatched / wTotal;
  const falsePositivesPerPr = fp / dataset.cases.length;
  const sorted = [...lat].sort((a, b) => a - b);
  const pct = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;
  const metrics: ScoreMetrics = {
    precision, recall, f1, severityWeightedRecall, falsePositivesPerPr,
    latencyP50Ms: pct(0.5), latencyP95Ms: pct(0.95), costPerPrUsd: cost / dataset.cases.length,
  };
  const k = rubric.composite;
  const fpTerm = 1 - Math.min(falsePositivesPerPr / rubric.fpPerPrCap, 1);
  const score = 100 * (k.severityWeightedRecall * severityWeightedRecall + k.precision * precision + k.fpPenalty * fpTerm)
    / (k.severityWeightedRecall + k.precision + k.fpPenalty);
  return { metrics, score };
}

/** Score all runs; final score is the mean, with population std dev as the reproducibility signal. */
export function scoreSubmission(dataset: Dataset, sub: Submission, rubric: Rubric) {
  if (sub.rubricVersion !== rubric.version) throw new Error(`rubric mismatch: ${sub.rubricVersion} != ${rubric.version}`);
  if (sub.datasetVersion !== dataset.version) throw new Error(`dataset mismatch: ${sub.datasetVersion} != ${dataset.version}`);
  if (sub.runs.length < rubric.minRuns) throw new Error(`need >= ${rubric.minRuns} runs, got ${sub.runs.length}`);
  const runs = sub.runs.map((r) => scoreRun(dataset, r.results, rubric));
  const mean = runs.reduce((s, r) => s + r.score, 0) / runs.length;
  const std = Math.sqrt(runs.reduce((s, r) => s + (r.score - mean) ** 2, 0) / runs.length);
  return { score: mean, scoreStdDev: std, runs };
}
