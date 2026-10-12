import { z } from "zod";

// Pure data contracts. No I/O. Every boundary (HTTP, queue, SDK) parses with these.

export const Severity = z.enum(["info", "low", "medium", "high", "critical"]);
export type Severity = z.infer<typeof Severity>;

/** Weights used by scoring rubric v1 (mirrors docs/scoring/rubric.v1.json). */
export const SEVERITY_WEIGHT: Record<Severity, number> = { info: 0, low: 1, medium: 2, high: 4, critical: 8 };

export const FindingCategory = z.enum([
  "bug", "security", "performance", "maintainability", "style", "test", "docs",
]);
export type FindingCategory = z.infer<typeof FindingCategory>;

const Id = z.string().min(1).max(128);
const Sha = z.string().regex(/^[0-9a-f]{7,64}$/, "git sha");
const IsoDate = z.string().datetime({ offset: true });

export const Location = z.object({
  path: z.string().min(1),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
}).refine((l) => l.endLine >= l.startLine, { message: "endLine < startLine" });
export type Location = z.infer<typeof Location>;

export const Finding = z.object({
  id: Id,
  reviewId: Id,
  ruleId: Id.optional(),
  category: FindingCategory,
  severity: Severity,
  title: z.string().min(1).max(200),
  body: z.string().max(20_000),
  location: Location,
  /** Related locations for multi-file findings (e.g. caller broken by callee change). */
  related: z.array(Location).default([]),
  suggestion: z.string().max(20_000).optional(),
  /** 0..1 calibrated confidence after verifier pass. */
  confidence: z.number().min(0).max(1),
  source: z.enum(["llm", "sast", "hybrid"]),
  cwe: z.array(z.string().regex(/^CWE-\d+$/)).default([]),
  /** Execution evidence (E0-E3): the command that failed, its exit code and a stderr excerpt. */
  evidence: z.object({ command: z.string().max(2000), exitCode: z.number().int(), stderrExcerpt: z.string().max(4000) }).optional(),
});
export type Finding = z.infer<typeof Finding>;

export const ReviewStatus = z.enum(["queued", "indexing", "reviewing", "verifying", "completed", "failed", "cancelled"]);
export type ReviewStatus = z.infer<typeof ReviewStatus>;

export const PullRequestRef = z.object({
  provider: z.enum(["github", "gitlab", "bitbucket", "azure"]),
  owner: z.string().min(1),
  repo: z.string().min(1),
  number: z.number().int().positive(),
  baseSha: Sha.optional(),
  headSha: Sha.optional(),
});
export type PullRequestRef = z.infer<typeof PullRequestRef>;

export const Usage = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
  latencyMs: z.number().int().nonnegative(),
});
export type Usage = z.infer<typeof Usage>;

export const Review = z.object({
  id: Id,
  tenantId: Id,
  repositoryId: Id,
  pullRequest: PullRequestRef.optional(),
  status: ReviewStatus,
  summary: z.string().optional(),
  findings: z.array(Finding).default([]),
  usage: Usage.optional(),
  createdAt: IsoDate,
  completedAt: IsoDate.optional(),
});
export type Review = z.infer<typeof Review>;

export const Rule = z.object({
  id: Id,
  tenantId: Id.optional(),
  name: z.string().min(1),
  description: z.string(),
  /** Glob patterns the rule applies to. */
  paths: z.array(z.string()).default(["**/*"]),
  severity: Severity,
  kind: z.enum(["natural-language", "semgrep", "learned"]),
  /** Natural-language instruction or semgrep YAML, depending on kind. */
  body: z.string().min(1),
  enabled: z.boolean().default(true),
});
export type Rule = z.infer<typeof Rule>;

export const RepoIndex = z.object({
  id: Id,
  repositoryId: Id,
  commitSha: Sha,
  status: z.enum(["pending", "building", "ready", "failed"]),
  languages: z.array(z.string()).default([]),
  fileCount: z.number().int().nonnegative(),
  symbolCount: z.number().int().nonnegative(),
  chunkCount: z.number().int().nonnegative(),
  embeddingModel: z.string(),
  /** Parent index this was incrementally derived from. */
  baseIndexId: Id.optional(),
  builtAt: IsoDate.optional(),
});
export type RepoIndex = z.infer<typeof RepoIndex>;

export const TestGenRun = z.object({
  id: Id,
  reviewId: Id.optional(),
  repositoryId: Id,
  status: z.enum(["queued", "generating", "running", "repairing", "completed", "failed"]),
  targetPaths: z.array(z.string()),
  testsKept: z.number().int().nonnegative().default(0),
  testsDiscarded: z.number().int().nonnegative().default(0),
  coverageDelta: z.number().optional(),
  patch: z.string().optional(),
});
export type TestGenRun = z.infer<typeof TestGenRun>;

export const AgentKind = z.enum(["planner", "bug-hunter", "security", "cross-file", "test-gen", "verifier", "summarizer", "semgrep-triage", "judge"]);
export type AgentKind = z.infer<typeof AgentKind>;

/** Chat model tiers (ADR 0006 names: cheap=small, standard=medium, premium=large). Embeddings use their own route. */
export const ModelTier = z.enum(["small", "medium", "large"]);
export type ModelTier = z.infer<typeof ModelTier>;

export const FeedbackVerdict = z.enum(["thumbs_up", "thumbs_down", "resolved", "dismissed"]);
export type FeedbackVerdict = z.infer<typeof FeedbackVerdict>;

export const Feedback = z.object({
  id: Id,
  findingId: Id,
  verdict: FeedbackVerdict,
  /** Optional free-text reason. Stored, never logged. */
  reason: z.string().max(2000).optional(),
  actor: z.string().max(200).optional(),
  createdAt: IsoDate,
});
export type Feedback = z.infer<typeof Feedback>;

/** Per-tenant review configuration (rules, path filters, tier overrides, noise controls). */
export const TenantConfig = z.object({
  rules: z.array(Rule).default([]),
  pathFilters: z.object({
    include: z.array(z.string()).default(["**/*"]),
    exclude: z.array(z.string()).default(["**/node_modules/**", "**/dist/**", "**/*.lock", "**/vendor/**"]),
  }).default({ include: ["**/*"], exclude: ["**/node_modules/**", "**/dist/**", "**/*.lock", "**/vendor/**"] }),
  tierOverrides: z.partialRecord(AgentKind, ModelTier).default({}),
  /** Findings below this calibrated confidence are dropped before posting. */
  confidenceThreshold: z.number().min(0).max(1).default(0.6),
  /** Max inline comments per PR, ranked by severity x confidence. */
  maxComments: z.number().int().min(0).max(100).default(15),
  /** Per-PR model spend cap in USD. */
  prBudgetUsd: z.number().positive().default(0.5),
  /** Per-tenant monthly model spend cap in USD. */
  monthlyBudgetUsd: z.number().positive().default(500),
});
export type TenantConfig = z.infer<typeof TenantConfig>;

export const SandboxLimits = z.object({
  cpus: z.number().positive().max(16).default(1),
  memoryMb: z.number().int().min(64).max(32768).default(1024),
  timeoutSec: z.number().int().min(1).max(3600).default(300),
  pids: z.number().int().min(16).max(4096).default(256),
  network: z.enum(["none", "egress-allowlist"]).default("none"),
});
export type SandboxLimits = z.infer<typeof SandboxLimits>;

export const ScoreMetrics = z.object({
  precision: z.number().min(0).max(1),
  recall: z.number().min(0).max(1),
  f1: z.number().min(0).max(1),
  severityWeightedRecall: z.number().min(0).max(1),
  falsePositivesPerPr: z.number().nonnegative(),
  latencyP50Ms: z.number().nonnegative(),
  latencyP95Ms: z.number().nonnegative(),
  costPerPrUsd: z.number().nonnegative(),
});
export type ScoreMetrics = z.infer<typeof ScoreMetrics>;

export const ScoreReport = z.object({
  id: Id,
  rubricVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  datasetVersion: z.string().min(1),
  system: z.object({ name: z.string(), version: z.string(), model: z.string().optional() }),
  metrics: ScoreMetrics,
  score: z.number().min(0).max(100),
  /** Repeated runs used to estimate variance (reproducibility). */
  runs: z.number().int().positive(),
  scoreStdDev: z.number().nonnegative(),
  createdAt: IsoDate,
});
export type ScoreReport = z.infer<typeof ScoreReport>;
