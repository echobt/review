import { randomUUID } from "node:crypto";
import {
  Feedback, Finding, RepoIndex, Review, ScoreJob, ScoreReport, TestGenRun,
  type FeedbackVerdict, type PullRequestRef, type ReviewStatus, type Usage,
} from "@review/core";
import type { Sql } from "./db.ts";

// Tenant-scoped persistence shared by gateway and workers. Always call inside withTenant(): RLS scopes every
// statement, and tenantId is passed explicitly only to stamp new rows (WITH CHECK rejects a mismatch).

const iso = (v: unknown): string | undefined => (v == null ? undefined : new Date(v as string).toISOString());
const num = (v: unknown) => (v == null ? undefined : Number(v));

/** API repository ids are opaque strings; ensure a repositories row exists so FKs hold. */
export async function ensureRepository(sql: Sql, tenantId: string, repositoryId: string, provider = "api", fullName = repositoryId) {
  await sql.query(`INSERT INTO repositories (id, tenant_id, provider, full_name) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING`,
    [repositoryId, tenantId, provider, fullName]);
}

// ---------- reviews + findings ----------
export async function createReview(sql: Sql, tenantId: string, r: { id?: string; repositoryId: string; pullRequest?: PullRequestRef; diffObjectKey?: string }): Promise<Review> {
  const id = r.id ?? randomUUID();
  await ensureRepository(sql, tenantId, r.repositoryId);
  await sql.query(`INSERT INTO reviews (id, tenant_id, repository_id, status, pr, diff_object_key) VALUES ($1, $2, $3, 'queued', $4, $5)`,
    [id, tenantId, r.repositoryId, r.pullRequest ? JSON.stringify(r.pullRequest) : null, r.diffObjectKey ?? null]);
  return (await getReview(sql, id))!;
}

export async function getReview(sql: Sql, id: string, opts: { withFindings?: boolean } = { withFindings: true }): Promise<Review | undefined> {
  const row = (await sql.query<Record<string, unknown>>("SELECT * FROM reviews WHERE id = $1", [id])).rows[0];
  if (!row) return undefined;
  return Review.parse({
    id: row.id, tenantId: row.tenant_id, repositoryId: row.repository_id, status: row.status,
    ...(row.pr ? { pullRequest: row.pr } : {}), ...(row.summary ? { summary: row.summary } : {}), ...(row.usage ? { usage: row.usage } : {}),
    findings: opts.withFindings === false ? [] : await listFindings(sql, id),
    createdAt: iso(row.created_at), ...(row.completed_at ? { completedAt: iso(row.completed_at) } : {}),
  });
}

export async function getReviewDiffKey(sql: Sql, id: string): Promise<string | undefined> {
  return (await sql.query<{ k: string | null }>("SELECT diff_object_key AS k FROM reviews WHERE id = $1", [id])).rows[0]?.k ?? undefined;
}

export async function updateReview(sql: Sql, id: string, u: { status: ReviewStatus; summary?: string; usage?: Usage }) {
  const done = ["completed", "failed", "cancelled"].includes(u.status);
  await sql.query(`UPDATE reviews SET status = $2, summary = COALESCE($3, summary), usage = COALESCE($4, usage),
    cost_usd = COALESCE($5, cost_usd), completed_at = CASE WHEN $6 THEN now() ELSE completed_at END WHERE id = $1`,
    [id, u.status, u.summary ?? null, u.usage ? JSON.stringify(u.usage) : null, u.usage?.costUsd ?? null, done]);
}

export interface StoredFinding { finding: Finding; fingerprint: string; agentTaskId?: string; posted?: boolean }

export async function insertFindings(sql: Sql, tenantId: string, items: StoredFinding[]) {
  for (const { finding: f, fingerprint, agentTaskId, posted } of items) {
    const v = Finding.parse(f);
    await sql.query(`INSERT INTO findings (id, tenant_id, review_id, agent_task_id, rule_id, fingerprint, category, severity, path, start_line, end_line, confidence, data, posted)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT (id) DO NOTHING`,
      [v.id, tenantId, v.reviewId, agentTaskId ?? null, v.ruleId ?? null, fingerprint, v.category, v.severity, v.location.path,
        v.location.startLine, v.location.endLine, v.confidence, JSON.stringify(v), posted ?? false]);
  }
}

export async function listFindings(sql: Sql, reviewId: string): Promise<Finding[]> {
  const rows = (await sql.query<{ data: unknown }>("SELECT data FROM findings WHERE review_id = $1 ORDER BY confidence DESC, id", [reviewId])).rows;
  return rows.map((r) => Finding.parse(r.data));
}

// ---------- feedback + suppression ----------
/** Negative verdicts suppress the finding's fingerprint for the repository (future reviews drop it). */
export const SUPPRESSING_VERDICTS: readonly FeedbackVerdict[] = ["thumbs_down", "dismissed"];

export async function addFeedback(sql: Sql, tenantId: string, findingId: string, fb: { verdict: FeedbackVerdict; reason?: string; actor?: string }): Promise<Feedback | undefined> {
  const f = (await sql.query<{ fingerprint: string; repository_id: string }>(
    "SELECT f.fingerprint, r.repository_id FROM findings f JOIN reviews r ON r.id = f.review_id WHERE f.id = $1", [findingId])).rows[0];
  if (!f) return undefined;
  const id = randomUUID();
  const row = (await sql.query<{ created_at: unknown }>(`INSERT INTO feedback (id, tenant_id, finding_id, verdict, reason, actor) VALUES ($1,$2,$3,$4,$5,$6) RETURNING created_at`,
    [id, tenantId, findingId, fb.verdict, fb.reason ?? null, fb.actor ?? null])).rows[0]!;
  if (SUPPRESSING_VERDICTS.includes(fb.verdict)) {
    await sql.query(`INSERT INTO suppressions (tenant_id, repository_id, fingerprint, reason) VALUES ($1,$2,$3,$4) ON CONFLICT (tenant_id, repository_id, fingerprint) DO NOTHING`,
      [tenantId, f.repository_id, f.fingerprint, fb.verdict]);
  }
  return Feedback.parse({ id, findingId, verdict: fb.verdict, ...(fb.reason ? { reason: fb.reason } : {}), ...(fb.actor ? { actor: fb.actor } : {}), createdAt: iso(row.created_at) });
}

/** Feedback on findings of one repository (input for learned suppression rules). */
export async function repositoryFeedback(sql: Sql, repositoryId: string): Promise<{ category: string; severity: string; path: string; verdict: FeedbackVerdict }[]> {
  return (await sql.query<{ category: string; severity: string; path: string; verdict: FeedbackVerdict }>(
    `SELECT f.category, f.severity, f.path, fb.verdict FROM feedback fb JOIN findings f ON f.id = fb.finding_id JOIN reviews r ON r.id = f.review_id WHERE r.repository_id = $1`, [repositoryId])).rows;
}

export async function suppressedFingerprints(sql: Sql, repositoryId: string): Promise<Set<string>> {
  return new Set((await sql.query<{ fingerprint: string }>("SELECT fingerprint FROM suppressions WHERE repository_id = $1", [repositoryId])).rows.map((r) => r.fingerprint));
}

// ---------- indexes ----------
export async function createIndexRecord(sql: Sql, tenantId: string, r: { id?: string; repositoryId: string; commitSha: string; embedModel: string; baseIndexId?: string }): Promise<RepoIndex> {
  const id = r.id ?? randomUUID();
  await ensureRepository(sql, tenantId, r.repositoryId);
  await sql.query(`INSERT INTO repo_indexes (id, tenant_id, repository_id, commit_sha, status, embed_model, base_index_id) VALUES ($1,$2,$3,$4,'pending',$5,$6) ON CONFLICT (id) DO NOTHING`,
    [id, tenantId, r.repositoryId, r.commitSha, r.embedModel, r.baseIndexId ?? null]);
  return (await getIndexRecord(sql, id))!;
}

export async function getIndexRecord(sql: Sql, id: string): Promise<RepoIndex | undefined> {
  const r = (await sql.query<Record<string, unknown>>("SELECT * FROM repo_indexes WHERE id = $1", [id])).rows[0];
  return r ? rowToIndex(r) : undefined;
}

/** Most recent ready index of a repository (base for incremental builds / retrieval). */
export async function latestReadyIndex(sql: Sql, repositoryId: string): Promise<RepoIndex | undefined> {
  const r = (await sql.query<Record<string, unknown>>("SELECT * FROM repo_indexes WHERE repository_id = $1 AND status = 'ready' ORDER BY built_at DESC NULLS LAST, created_at DESC LIMIT 1", [repositoryId])).rows[0];
  return r ? rowToIndex(r) : undefined;
}

export async function updateIndexRecord(sql: Sql, id: string, u: { status: RepoIndex["status"]; languages?: string[]; fileCount?: number; symbolCount?: number; chunkCount?: number }) {
  await sql.query(`UPDATE repo_indexes SET status = $2, languages = COALESCE($3, languages), file_count = COALESCE($4, file_count),
    symbol_count = COALESCE($5, symbol_count), chunk_count = COALESCE($6, chunk_count), built_at = CASE WHEN $2 = 'ready' THEN now() ELSE built_at END WHERE id = $1`,
    [id, u.status, u.languages ?? null, u.fileCount ?? null, u.symbolCount ?? null, u.chunkCount ?? null]);
}

/** Lookup: a ready index already built for exactly this commit (a second review of the same head never rebuilds). */
export async function readyIndexForCommit(sql: Sql, repositoryId: string, commitSha: string): Promise<RepoIndex | undefined> {
  const r = (await sql.query<Record<string, unknown>>("SELECT * FROM repo_indexes WHERE repository_id = $1 AND commit_sha = $2 AND status = 'ready' ORDER BY built_at DESC NULLS LAST LIMIT 1", [repositoryId, commitSha])).rows[0];
  return r ? rowToIndex(r) : undefined;
}

/** Lookup: the index a tracked branch currently points at. */
export async function branchHead(sql: Sql, repositoryId: string, branch: string): Promise<RepoIndex | undefined> {
  const r = (await sql.query<Record<string, unknown>>("SELECT i.* FROM branch_heads b JOIN repo_indexes i ON i.id = b.index_id WHERE b.repository_id = $1 AND b.branch = $2", [repositoryId, branch])).rows[0];
  return r ? rowToIndex(r) : undefined;
}

/** Update: move a branch head to a ready index (push webhook -> incremental index -> swap). */
export async function setBranchHead(sql: Sql, tenantId: string, h: { repositoryId: string; branch: string; indexId: string; commitSha: string }) {
  await sql.query(`INSERT INTO branch_heads (tenant_id, repository_id, branch, index_id, commit_sha) VALUES ($1,$2,$3,$4,$5)
    ON CONFLICT (tenant_id, repository_id, branch) DO UPDATE SET index_id = EXCLUDED.index_id, commit_sha = EXCLUDED.commit_sha, updated_at = now()`,
    [tenantId, h.repositoryId, h.branch, h.indexId, h.commitSha]);
}

/** Invalidation: drop one branch head (or all heads of the repo) so the next lookup misses and a rebuild is scheduled. */
export async function invalidateBranchHead(sql: Sql, repositoryId: string, branch?: string): Promise<number> {
  const r = branch === undefined
    ? await sql.query("DELETE FROM branch_heads WHERE repository_id = $1 RETURNING 1", [repositoryId])
    : await sql.query("DELETE FROM branch_heads WHERE repository_id = $1 AND branch = $2 RETURNING 1", [repositoryId, branch]);
  return r.rows.length;
}

const rowToIndex = (r: Record<string, unknown>): RepoIndex => RepoIndex.parse({
  id: r.id, repositoryId: r.repository_id, commitSha: r.commit_sha, status: r.status, languages: r.languages ?? [],
  fileCount: num(r.file_count) ?? 0, symbolCount: num(r.symbol_count) ?? 0, chunkCount: num(r.chunk_count) ?? 0,
  embeddingModel: r.embed_model, ...(r.base_index_id ? { baseIndexId: r.base_index_id } : {}), ...(r.built_at ? { builtAt: iso(r.built_at) } : {}),
});

// ---------- test generation ----------
export async function createTestGenRecord(sql: Sql, tenantId: string, r: { id?: string; repositoryId: string; reviewId?: string; targetPaths: string[] }): Promise<TestGenRun> {
  const id = r.id ?? randomUUID();
  await sql.query(`INSERT INTO test_gen_runs (id, tenant_id, review_id, repository_id, status, target_paths) VALUES ($1,$2,$3,$4,'queued',$5)`,
    [id, tenantId, r.reviewId ?? null, r.repositoryId, r.targetPaths]);
  return (await getTestGenRecord(sql, id))!;
}

export async function getTestGenRecord(sql: Sql, id: string): Promise<TestGenRun | undefined> {
  const r = (await sql.query<Record<string, unknown>>("SELECT * FROM test_gen_runs WHERE id = $1", [id])).rows[0];
  if (!r) return undefined;
  const res = (r.result ?? {}) as Partial<TestGenRun>;
  return TestGenRun.parse({ ...res, id: r.id, repositoryId: r.repository_id, status: r.status, targetPaths: r.target_paths, ...(r.review_id ? { reviewId: r.review_id } : {}) });
}

export async function updateTestGenRecord(sql: Sql, id: string, u: { status: TestGenRun["status"]; attempts?: number; result?: Partial<TestGenRun> }) {
  await sql.query(`UPDATE test_gen_runs SET status = $2, attempts = COALESCE($3, attempts), result = COALESCE($4, result) WHERE id = $1`,
    [id, u.status, u.attempts ?? null, u.result ? JSON.stringify(u.result) : null]);
}

// ---------- scores + usage ----------
export async function createScoreJob(sql: Sql, tenantId: string, j: { id?: string; reviewId: string; datasetCaseId: string; rubricVersion: string }): Promise<ScoreJob> {
  const id = j.id ?? randomUUID();
  await sql.query(`INSERT INTO score_reports (id, tenant_id, review_id, dataset_case_id, status, rubric_version) VALUES ($1,$2,$3,$4,'queued',$5)`,
    [id, tenantId, j.reviewId, j.datasetCaseId, j.rubricVersion]);
  return { id, reviewId: j.reviewId, datasetCaseId: j.datasetCaseId, status: "queued" };
}

/** Completes a queued job (or inserts a standalone report when no job row exists, e.g. replay runs). */
export async function completeScoreJob(sql: Sql, tenantId: string, id: string, r: { reviewId?: string; datasetCaseId?: string; report?: ScoreReport; error?: string }) {
  const report = r.report ? ScoreReport.parse(r.report) : undefined;
  await sql.query(`INSERT INTO score_reports (id, tenant_id, review_id, dataset_case_id, status, rubric_version, dataset_version, score, data, error)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, dataset_version = EXCLUDED.dataset_version, score = EXCLUDED.score, data = EXCLUDED.data, error = EXCLUDED.error`,
    [id, tenantId, r.reviewId ?? null, r.datasetCaseId ?? null, report ? "completed" : "failed", report?.rubricVersion ?? "unknown",
      report?.datasetVersion ?? null, report?.score ?? null, report ? JSON.stringify(report) : null, r.error ?? null]);
}

export async function getScoreJob(sql: Sql, id: string): Promise<ScoreJob | undefined> {
  const r = (await sql.query<Record<string, unknown>>("SELECT * FROM score_reports WHERE id = $1", [id])).rows[0];
  if (!r) return undefined;
  return ScoreJob.parse({ id: r.id, reviewId: r.review_id ?? "", datasetCaseId: r.dataset_case_id ?? "", status: r.status,
    ...(r.data ? { report: r.data } : {}), ...(r.error ? { error: r.error } : {}) });
}

export async function recordUsage(sql: Sql, tenantId: string, u: { reviewId?: string; model: string; inputTokens: number; outputTokens: number; costUsd: number }) {
  await sql.query(`INSERT INTO usage_ledger (tenant_id, review_id, model, input_tokens, output_tokens, cost_usd) VALUES ($1,$2,$3,$4,$5,$6)`,
    [tenantId, u.reviewId ?? null, u.model, u.inputTokens, u.outputTokens, u.costUsd]);
}

/** Month-to-date spend for budget enforcement across processes. */
export async function monthToDateSpend(sql: Sql): Promise<number> {
  return Number((await sql.query<{ s: string | null }>("SELECT COALESCE(sum(cost_usd), 0) AS s FROM usage_ledger WHERE at >= date_trunc('month', now())")).rows[0]?.s ?? 0);
}
