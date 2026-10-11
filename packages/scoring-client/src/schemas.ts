import { z } from "zod";
import { FindingCategory, Severity } from "@review/core";

// Mirrors the JSON Schemas in docs/scoring/ (public repo echobt/code-review-scoring).

const Semver = z.string().regex(/^\d+\.\d+\.\d+$/);
const Range = z.object({ path: z.string().min(1), startLine: z.number().int().positive(), endLine: z.number().int().positive() });

export const LabelledBug = z.object({
  id: z.string().min(1),
  category: FindingCategory,
  severity: Severity,
  location: Range,
  description: z.string().min(1),
  cwe: z.array(z.string()).default([]),
});
export type LabelledBug = z.infer<typeof LabelledBug>;

export const DatasetCase = z.object({
  id: z.string().min(1),
  repo: z.string().url(),
  baseSha: z.string().regex(/^[0-9a-f]{40}$/),
  headSha: z.string().regex(/^[0-9a-f]{40}$/),
  language: z.string(),
  license: z.string().min(1),
  /** Ground-truth defects introduced by the PR. Empty = clean PR (measures false positives). */
  bugs: z.array(LabelledBug),
  provenance: z.enum(["real-fix-commit", "injected", "cve"]),
});
export type DatasetCase = z.infer<typeof DatasetCase>;

export const Dataset = z.object({ version: z.string().min(1), cases: z.array(DatasetCase).min(1) });
export type Dataset = z.infer<typeof Dataset>;

export const SubmittedFinding = z.object({
  category: FindingCategory,
  severity: Severity,
  location: Range,
  title: z.string(),
  confidence: z.number().min(0).max(1).default(1),
});
export type SubmittedFinding = z.infer<typeof SubmittedFinding>;

export const CaseResult = z.object({
  caseId: z.string(),
  findings: z.array(SubmittedFinding),
  latencyMs: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
});
export type CaseResult = z.infer<typeof CaseResult>;

export const Submission = z.object({
  system: z.object({ name: z.string().min(1), version: z.string().min(1), model: z.string().optional(), url: z.string().url().optional() }),
  rubricVersion: Semver,
  datasetVersion: z.string(),
  /** Independent repeated runs over the full dataset; rubric requires >= minRuns. */
  runs: z.array(z.object({ results: z.array(CaseResult).min(1) })).min(1),
  harness: z.object({ commit: z.string(), command: z.string() }),
});
export type Submission = z.infer<typeof Submission>;

export const Rubric = z.object({
  version: Semver,
  matching: z.object({ lineTolerance: z.number().int().nonnegative(), requireCategory: z.boolean() }),
  severityWeights: z.record(Severity, z.number().nonnegative()),
  composite: z.object({ severityWeightedRecall: z.number(), precision: z.number(), fpPenalty: z.number() }),
  fpPerPrCap: z.number().positive(),
  minRuns: z.number().int().positive(),
});
export type Rubric = z.infer<typeof Rubric>;

export const LeaderboardEntry = z.object({
  rank: z.number().int().positive(),
  system: Submission.shape.system,
  rubricVersion: Semver,
  datasetVersion: z.string(),
  score: z.number().min(0).max(100),
  scoreStdDev: z.number().nonnegative(),
  precision: z.number(), recall: z.number(), severityWeightedRecall: z.number(),
  falsePositivesPerPr: z.number(), latencyP50Ms: z.number(), costPerPrUsd: z.number(),
  verified: z.boolean(),
  submissionPath: z.string(),
});
export type LeaderboardEntry = z.infer<typeof LeaderboardEntry>;

export const Leaderboard = z.object({ rubricVersion: Semver, datasetVersion: z.string(), generatedAt: z.string(), entries: z.array(LeaderboardEntry) });
export type Leaderboard = z.infer<typeof Leaderboard>;
