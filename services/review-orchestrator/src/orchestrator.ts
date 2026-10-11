import { randomUUID } from "node:crypto";
import { Finding, TenantConfig, type AgentKind, type PullRequestRef, type Usage } from "@review/core";
import type { FindingDraft } from "@review/schemas";
import { getTenantConfig, insertFindings, suppressedFingerprints, updateReview, withTenant, type Database } from "@review/db";
import type { Producer } from "@review/queue";
import { filterFiles, parseDiff, planReview } from "./plan.ts";
import { mergeFindings } from "./merge.ts";
import { buildCheckRun, buildReviewPayload, type GitHubClient } from "./github.ts";

/** Structural port matching agent-runner's runAgent(deps, task); production wiring calls it in-process. */
export interface AgentRequest {
  tenantId: string; reviewId: string; kind: AgentKind; config: TenantConfig;
  context: { files: { path: string; patch: string }[]; rules: { name: string; body: string }[]; notes?: string };
}
export interface AgentOutcome { status: "completed" | "partial" | "failed"; drafts: FindingDraft[]; summary?: string; usage: Usage }
export type AgentExecutor = (req: AgentRequest) => Promise<AgentOutcome>;

export interface OrchestratorDeps {
  executor: AgentExecutor;
  producer: Producer;
  db?: Database;
  github?: GitHubClient;
  /** Used when no db is configured (memory mode). */
  config?: TenantConfig;
}

export interface ReviewInput { tenantId: string; reviewId: string; repositoryId: string; diff: string; pullRequest?: PullRequestRef }
export interface ReviewOutcome { findings: Finding[]; summary: string; usage: Usage; partial: boolean }

const addUsage = (a: Usage, b: Usage): Usage => ({ inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens,
  costUsd: a.costUsd + b.costUsd, latencyMs: Math.max(a.latencyMs, b.latencyMs) });

export function fallbackSummary(findings: Finding[], fileCount: number): string {
  const by = (s: string) => findings.filter((f) => f.severity === s).length;
  const counts = ["critical", "high", "medium", "low", "info"].map((s) => [s, by(s)] as const).filter(([, n]) => n).map(([s, n]) => `${n} ${s}`).join(", ");
  return `Reviewed ${fileCount} file(s). ${findings.length ? `${findings.length} finding(s): ${counts}.` : "No issues found."}`;
}

export async function runReview(deps: OrchestratorDeps, input: ReviewInput): Promise<ReviewOutcome> {
  const { tenantId, reviewId } = input;
  const tx = <T>(fn: Parameters<typeof withTenant<T>>[2]) => deps.db ? withTenant(deps.db, tenantId, fn) : Promise.resolve(undefined);
  const config = (await tx((sql) => getTenantConfig(sql, tenantId))) ?? deps.config ?? TenantConfig.parse({});
  await tx((sql) => updateReview(sql, reviewId, { status: "reviewing" }));
  try {
    const files = filterFiles(parseDiff(input.diff), config.pathFilters);
    const units = planReview(files, config);
    const results = await Promise.all(units.map((u) => deps.executor({ tenantId, reviewId, kind: u.kind, config, context: { files: u.files, rules: u.rules } })));
    let usage: Usage = { inputTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: 0 };
    for (const r of results) usage = addUsage(usage, r.usage);
    const candidates = results.flatMap((r) => r.drafts.map((d) => Finding.parse({ ...d, id: randomUUID(), reviewId, source: "llm" })));
    const suppressed = (await tx((sql) => suppressedFingerprints(sql, input.repositoryId))) ?? new Set<string>();
    const kept = mergeFindings(candidates, { config, suppressed });
    const findings = kept.map((k) => k.finding);

    let summary = fallbackSummary(findings, files.length);
    const partial = results.some((r) => r.status !== "completed");
    if (findings.length || files.length) {
      const notes = findings.map((f) => `- [${f.severity}] ${f.location.path}:${f.location.startLine} ${f.title}`).join("\n");
      const s = await deps.executor({ tenantId, reviewId, kind: "summarizer", config, context: { files: files.map((f) => ({ path: f.path, patch: "" })), rules: [], notes } });
      usage = addUsage(usage, s.usage);
      if (s.status === "completed" && s.summary) summary = s.summary;
    }

    const pr = input.pullRequest;
    const posted = Boolean(pr && deps.github);
    if (pr && deps.github) {
      await deps.github.createReview(pr, buildReviewPayload(summary, findings));
      if (pr.headSha) await deps.github.createCheckRun(pr, buildCheckRun(pr.headSha, summary, findings));
    }
    await tx(async (sql) => {
      await insertFindings(sql, tenantId, kept.map((k) => ({ finding: k.finding, fingerprint: k.fingerprint, posted })));
      await updateReview(sql, reviewId, { status: "completed", summary, usage });
    });
    for (const finding of findings) await deps.producer.send("finding.created", tenantId, { finding }, { jobId: `finding:${finding.id}` });
    await deps.producer.send("review.completed", tenantId, { reviewId, findingCount: findings.length, usage }, { jobId: `review-completed:${reviewId}` });
    return { findings, summary, usage, partial };
  } catch (e) {
    await tx((sql) => updateReview(sql, reviewId, { status: "failed" }));
    throw e;
  }
}
