import type { Finding, PullRequestRef } from "@review/core";

export interface InlineComment { path: string; line: number; side: "RIGHT" | "LEFT"; body: string }
export interface ReviewPayload { body: string; comments: InlineComment[] }
export interface Annotation { path: string; start_line: number; end_line: number; annotation_level: "notice" | "warning" | "failure"; title: string; message: string }
export interface CheckRunPayload { name: string; headSha: string; conclusion: "success" | "neutral" | "failure"; summary: string; annotations: Annotation[] }

export interface GitHubClient {
  getPullRequestDiff(pr: PullRequestRef): Promise<string>;
  createReview(pr: PullRequestRef, review: ReviewPayload): Promise<void>;
  createCheckRun(pr: PullRequestRef, check: CheckRunPayload): Promise<void>;
}

/** Installation access token for the repository's GitHub App installation. */
export type TokenProvider = (pr: PullRequestRef) => Promise<string>;

export class RecordingGitHubClient implements GitHubClient {
  readonly reviews: { pr: PullRequestRef; review: ReviewPayload }[] = [];
  readonly checks: { pr: PullRequestRef; check: CheckRunPayload }[] = [];
  readonly diffs: Map<string, string>;
  constructor(diffs: Record<string, string> = {}) { this.diffs = new Map(Object.entries(diffs)); }
  static key = (pr: PullRequestRef) => `${pr.owner}/${pr.repo}#${pr.number}`;
  async getPullRequestDiff(pr: PullRequestRef) {
    const d = this.diffs.get(RecordingGitHubClient.key(pr));
    if (d === undefined) throw new Error(`no diff recorded for ${RecordingGitHubClient.key(pr)}`);
    return d;
  }
  async createReview(pr: PullRequestRef, review: ReviewPayload) { this.reviews.push({ pr, review }); }
  async createCheckRun(pr: PullRequestRef, check: CheckRunPayload) { this.checks.push({ pr, check }); }
}

/** REST client over fetch (no Octokit dependency). Error messages carry status only, never response bodies. */
export class OctokitlessGitHubClient implements GitHubClient {
  readonly #token: TokenProvider;
  readonly #fetch: typeof fetch;
  readonly #base: string;
  constructor(token: TokenProvider, opts: { fetch?: typeof fetch; baseUrl?: string } = {}) {
    this.#token = token; this.#fetch = opts.fetch ?? fetch; this.#base = opts.baseUrl ?? "https://api.github.com";
  }
  async #call(pr: PullRequestRef, method: string, path: string, body?: unknown, accept = "application/vnd.github+json"): Promise<Response> {
    const res = await this.#fetch(`${this.#base}/repos/${encodeURIComponent(pr.owner)}/${encodeURIComponent(pr.repo)}${path}`, {
      method, headers: { authorization: `Bearer ${await this.#token(pr)}`, accept, "x-github-api-version": "2022-11-28", ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) { await res.body?.cancel().catch(() => undefined); throw new Error(`github ${method} ${path}: HTTP ${res.status}`); }
    return res;
  }
  async getPullRequestDiff(pr: PullRequestRef) { return (await this.#call(pr, "GET", `/pulls/${pr.number}`, undefined, "application/vnd.github.diff")).text(); }
  async createReview(pr: PullRequestRef, r: ReviewPayload) {
    await this.#call(pr, "POST", `/pulls/${pr.number}/reviews`, { ...(pr.headSha ? { commit_id: pr.headSha } : {}), event: "COMMENT", body: r.body, comments: r.comments });
  }
  async createCheckRun(pr: PullRequestRef, c: CheckRunPayload) {
    await this.#call(pr, "POST", "/check-runs", { name: c.name, head_sha: c.headSha, status: "completed", conclusion: c.conclusion,
      output: { title: c.name, summary: c.summary, annotations: c.annotations } });
  }
}

// ---------- payload builders ----------
const LEVEL = { critical: "failure", high: "failure", medium: "warning", low: "notice", info: "notice" } as const;

export function commentBody(f: Finding): string {
  const s = f.suggestion ? `\n\n\`\`\`suggestion\n${f.suggestion}\n\`\`\`` : "";
  return `**${f.severity.toUpperCase()} (${f.category}): ${f.title}**\n\n${f.body}${s}`;
}

export function buildReviewPayload(summary: string, findings: Finding[]): ReviewPayload {
  // ponytail: comments anchor to endLine on the new side; lines outside the diff hunks are rejected by GitHub. Map to hunk ranges when that bites.
  return { body: summary, comments: findings.map((f) => ({ path: f.location.path, line: f.location.endLine, side: "RIGHT", body: commentBody(f) })) };
}

export function buildCheckRun(headSha: string, summary: string, findings: Finding[]): CheckRunPayload {
  const conclusion = findings.some((f) => f.severity === "critical" || f.severity === "high") ? "failure" : findings.length ? "neutral" : "success";
  return { name: "AI Code Review", headSha, conclusion, summary,
    annotations: findings.slice(0, 50).map((f) => ({ path: f.location.path, start_line: f.location.startLine, end_line: f.location.endLine,
      annotation_level: LEVEL[f.severity], title: f.title, message: f.body })) };
}
