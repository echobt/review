import { randomUUID } from "node:crypto";
import { Finding, TenantConfig, type AgentKind, type PullRequestRef, type Usage } from "@review/core";
import type { FindingDraft } from "@review/schemas";
import { getTenantConfig, insertFindings, repositoryFeedback, suppressedFingerprints, updateReview, withTenant, type Database } from "@review/db";
import type { ModelRouter } from "@review/models";
import type { Producer } from "@review/queue";
import { execLanguage, validateExecution, type ExecutionPort } from "@review/sandbox-runner";
import { filterFiles, isCode, parseDiff, planReview, type DiffFile } from "./plan.ts";
import { addedLines, buildContextPack, type ContextPack, type IndexerPort } from "./pack.ts";
import { Candidate, runPipeline } from "./review.ts";
import { selectDepth, tierSignals } from "./tier.ts";
import { applyLearnedRules, learnSuppressionRules, type FeedbackEvent } from "./learning.ts";
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
  /**
   * Multi-agent engine (GREPTILE-GAP §3-5): with an indexer and a router, the review builds a context pack at the PR head and runs
   * planner -> hunters -> verifier instead of the single-pass agents. `execution` adds E0-E3 checks; absent = static only.
   */
  indexer?: IndexerPort;
  router?: ModelRouter;
  /** Execution port bound to a checkout of repo@headSha (E0-E3); `release` (if any) removes the worktree after the review. */
  execution?: (repositoryId: string, headSha: string) => Promise<ExecutionPort & { release?: () => Promise<void> }>;
  log?: (e: Record<string, unknown>) => void;
}

export interface ReviewInput { tenantId: string; reviewId: string; repositoryId: string; diff: string; pullRequest?: PullRequestRef; headSha?: string }
export interface ReviewOutcome {
  findings: Finding[]; summary: string; usage: Usage; partial: boolean;
  engine: "single-pass" | "multi-agent";
  /** Present for the multi-agent engine. */
  stats?: { hypotheses: number; candidates: number; verified: number; executionFindings: number; learnedSuppressed: number; pack: ContextPack["stats"]; tasks: number; failures: number;
    depth: string; depthReason: string; width: number; llmCalls: number; cachedTokens: number; deterministicConfirmed: number };
}

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
    const headSha = input.headSha ?? input.pullRequest?.headSha;
    let usage: Usage = { inputTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: 0 };
    let candidates: Finding[];
    let partialNote: string | undefined;
    let stats: ReviewOutcome["stats"];
    const engine: ReviewOutcome["engine"] = deps.indexer && deps.router && headSha ? "multi-agent" : "single-pass";
    if (engine === "multi-agent") {
      const r = await multiAgent(deps, input, files, config, headSha!);
      usage = r.usage; candidates = r.findings; stats = r.stats; partialNote = r.partialNote;
    } else {
      const units = planReview(files, config);
      const results = await Promise.all(units.map((u) => deps.executor({ tenantId, reviewId, kind: u.kind, config, context: { files: u.files, rules: u.rules } })));
      // Every review agent failing (e.g. no provider configured, outage) must not read as "No issues found".
      if (results.length && results.every((r) => r.status === "failed")) throw new Error(`all ${results.length} review agents failed`);
      for (const r of results) usage = addUsage(usage, r.usage);
      candidates = results.flatMap((r) => r.drafts.map((d) => Finding.parse({ ...d, id: randomUUID(), reviewId, source: "llm" })));
      const bad = results.filter((r) => r.status !== "completed").length;
      if (bad) partialNote = `Partial review: ${bad} of ${results.length} agents did not complete (budget or provider failure).`;
    }
    const suppressed = (await tx((sql) => suppressedFingerprints(sql, input.repositoryId))) ?? new Set<string>();
    // Learned suppression (GAP §7.2): clusters of dismissed feedback; guardrail keeps high/critical and security.
    if (config.learning) {
      const events = (await tx((sql) => repositoryFeedback(sql, input.repositoryId))) ?? [];
      const learned = applyLearnedRules(candidates, learnSuppressionRules(events as FeedbackEvent[]));
      if (stats) stats.learnedSuppressed = learned.suppressed.length;
      candidates = learned.kept;
    }
    const kept = mergeFindings(candidates, { config, suppressed });
    const findings = kept.map((k) => k.finding);

    const partial = partialNote !== undefined;
    let summary = fallbackSummary(findings, files.length);
    if (findings.length || files.length) {
      const notes = findings.map((f) => `- [${f.severity}] ${f.location.path}:${f.location.startLine} ${f.title}`).join("\n");
      const t0 = Date.now();
      const s = await deps.executor({ tenantId, reviewId, kind: "summarizer", config, context: { files: files.map((f) => ({ path: f.path, patch: "" })), rules: [], notes } });
      deps.log?.({ event: "phase_end", phase: "summary", ms: Date.now() - t0 });
      usage = addUsage(usage, s.usage);
      if (s.status === "completed" && s.summary) summary = s.summary;
    }
    if (partialNote) summary += `\n\n${partialNote}`;

    const pr = input.pullRequest;
    const posted = Boolean(pr && deps.github);
    const tPost = Date.now();
    if (pr && deps.github) {
      await deps.github.createReview(pr, buildReviewPayload(summary, findings));
      if (pr.headSha) await deps.github.createCheckRun(pr, buildCheckRun(pr.headSha, summary, findings));
    }
    await tx(async (sql) => {
      await insertFindings(sql, tenantId, kept.map((k) => ({ finding: k.finding, fingerprint: k.fingerprint, posted })));
      await updateReview(sql, reviewId, { status: "completed", summary, usage });
    });
    for (const finding of findings) await deps.producer.send("finding.created", tenantId, { finding }, { jobId: `finding-${finding.id}` });
    deps.log?.({ event: "phase_end", phase: "post", ms: Date.now() - tPost });
    await deps.producer.send("review.completed", tenantId, { reviewId, findingCount: findings.length, usage }, { jobId: `review-completed-${reviewId}` });
    return { findings, summary, usage, partial, engine, ...(stats ? { stats } : {}) };
  } catch (e) {
    await tx((sql) => updateReview(sql, reviewId, { status: "failed" }));
    throw e;
  }
}

/** Python/Java/... class names declared on added lines (E1 instantiation targets). */
function changedClasses(files: DiffFile[]): { path: string; name: string }[] {
  return files.flatMap((f) => addedLines(f).flatMap(({ text }) => { const m = /^\s*class\s+([A-Za-z_]\w*)/.exec(text); return m ? [{ path: f.path, name: m[1]! }] : []; }));
}

/** Missing internal imports found by the pack are deterministic defects: escalate them to the verifier as candidates. */
function importSeeds(pack: ContextPack): Candidate[] {
  return pack.imports.filter((i) => i.status === "missing").slice(0, 10).map((i) => Candidate.parse({
    category: "bug", severity: "high", confidence: 0.7, location: { path: i.path, startLine: i.line, endLine: i.line },
    title: `Import of ${i.name ?? i.module} from ${i.module} does not resolve`,
    body: `The change imports ${i.name ? `${i.name} from ` : ""}${i.module}, but ${i.name ? "that module does not define or re-export it" : "the module does not exist in the repository"} at the PR head. This fails at import time.`,
    evidence_text: `import resolution: ${i.module}${i.name ? `.${i.name}` : ""} -> missing${i.resolvedPath ? ` (looked in ${i.resolvedPath})` : ""}`,
  }));
}

/**
 * ensureIndexed -> (E0/E1 deterministic checks in parallel) -> context pack -> streamed planner/hunters/verifier -> E2/E3.
 * Returns platform findings (not yet merged).
 */
async function multiAgent(deps: OrchestratorDeps, input: ReviewInput, files: DiffFile[], config: TenantConfig, headSha: string) {
  const log = deps.log;
  const timed = async <T>(phase: string, p: () => Promise<T>): Promise<T> => { const t0 = Date.now(); log?.({ event: "phase_start", phase }); try { return await p(); } finally { log?.({ event: "phase_end", phase, ms: Date.now() - t0 }); } };
  const code = files.filter((f) => isCode(f.path));
  const added = new Map(code.map((f) => [f.path, addedLines(f).map((l) => l.line)]));
  // Deterministic stage at t~0 (LATENCY-PLAN §5.2.1): sandbox checkout + E0/E1 run next to indexing and the LLM pipeline.
  const portP = deps.execution ? timed("exec.checkout", () => deps.execution!(input.repositoryId, headSha)) : undefined;
  portP?.catch(() => undefined);
  const early = portP?.then((port) => timed("exec.E0E1", () => validateExecution(port, { added, changedPaths: code.map((f) => f.path), classes: changedClasses(code), levels: ["E0", "E1"] })));
  early?.catch(() => undefined);
  try {
    const index = await timed("index.ensure", () => deps.indexer!.ensureIndexed(input.repositoryId, headSha));
    const pack = await timed("pack.build", () => buildContextPack(index, code, { log: (section, ms) => log?.({ event: "phase_end", phase: `pack.${section}`, ms }) }));
    log?.({ event: "pack", ...pack.stats, files: pack.files.length, definitions: pack.definitions.length, classes: pack.classes.length, imports: pack.imports.length });
    const det = early?.then((r) => r.findings.map((f) => f.location), () => []);
    const auto = selectDepth(config.reviewDepth, tierSignals(code));
    log?.({ event: "tier", depth: auto.depth, reason: auto.reason });
    const scope = { tenantId: input.tenantId, reviewId: input.reviewId };
    const result = await runPipeline({ router: deps.router!, index, scope, ...(log ? { log } : {}), ...(det ? { deterministic: det } : {}) }, code, pack, { ...config, reviewDepth: auto.depth },
      { seeds: Promise.resolve(importSeeds(pack)) });
    if (result.tasks > 0 && result.failures >= result.tasks) throw new Error(`all ${result.tasks} review agents failed`);
    const findings: Finding[] = result.kept.map(({ evidence_text: _e, test: _t, ...d }) => Finding.parse({ ...d, id: randomUUID(), reviewId: input.reviewId, source: "llm" }));
    let executionFindings = 0;
    if (portP && early) {
      const tests = pack.callers.flatMap((c) => c.tests.map((t) => t.path));
      // E3: tests the hunters wrote for kept findings; a test failing on head confirms its finding.
      const hypothesisTests = result.kept.flatMap((k) => { const language = k.test && execLanguage(k.test.path); return k.test && language ? [{ ...k.test, language, target: k.location, title: k.title }] : []; });
      const first = await early;
      const port = await portP;
      const late = await timed("exec.E2E3", () => validateExecution(port, { added, changedPaths: code.map((f) => f.path), testPaths: tests, hypothesisTests, levels: ["E2", "E3"] }));
      const rep = { runs: [...first.runs, ...late.runs], findings: [...first.findings, ...late.findings] };
      log?.({ event: "execution", runs: rep.runs });
      for (const ef of rep.findings) {
        // An execution failure confirms the overlapping LLM finding (hybrid) or stands alone; it is always diff-anchored by toFindings.
        const twin = findings.find((f) => f.location.path === ef.location.path && Math.abs(f.location.startLine - ef.location.startLine) <= 3);
        if (twin) { twin.source = "hybrid"; twin.confidence = Math.max(twin.confidence, ef.confidence); twin.evidence = ef.evidence; continue; }
        const { level: _l, ...rest } = ef;
        findings.push(Finding.parse({ ...rest, id: randomUUID(), reviewId: input.reviewId, source: "hybrid" }));
        executionFindings++;
      }
    }
    return {
      findings, usage: result.usage,
      partialNote: result.failures ? `Partial review: ${result.failures} of ${result.tasks} agent calls failed${result.budgetExhausted ? " (budget exhausted)" : ""}.` : undefined,
      stats: { hypotheses: result.hypotheses.length, candidates: result.candidates.length, verified: result.kept.length, executionFindings, learnedSuppressed: 0, pack: pack.stats, tasks: result.tasks, failures: result.failures,
        depth: auto.depth, depthReason: auto.reason, width: result.width, llmCalls: result.llmCalls, cachedTokens: result.cachedTokens, deterministicConfirmed: result.deterministicConfirmed },
    };
  } finally {
    await portP?.then((p) => p.release?.(), () => undefined);
  }
}
