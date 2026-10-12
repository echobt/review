// Build the greptile-50 dataset from the published case table (cases.json) and the public benchmark forks.
// Usage: GH_TOKEN=... node scripts/bench/extract.ts [--out docs/scoring/datasets/greptile-50/dataset.json] [--repo sentry]
// For each case: base/head SHA of the fork PR and the line comments left by every tool that caught it (label candidates).
// The bug location is the catching tool's comment that best matches the bug description (keyword overlap); `labelSource`
// records that, and a human-verified label (labels.json) always wins. Nothing here is shown to the engine under test.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";

const arg = (k: string, d?: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const here = (p: string) => new URL(p, import.meta.url).pathname;
const out = arg("--out", new URL("../../docs/scoring/datasets/greptile-50/dataset.json", import.meta.url).pathname)!;
const only = arg("--repo");
const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;

interface Case { id: string; repo: string; language: string; license: string; forkPr: number; toolPrs: Record<string, number>; bug: string; severity: string; published: Record<string, boolean> }
export interface Comment { tool: string; path: string; line: number; startLine?: number; body: string }
const table = JSON.parse(readFileSync(here("./cases.json"), "utf8")) as { tools: string[]; cases: Case[] };
const labels: Record<string, { path: string; startLine: number; endLine: number; acceptAlso?: { path: string; startLine: number; endLine: number }[]; note?: string }> =
  existsSync(here("./labels.json")) ? JSON.parse(readFileSync(here("./labels.json"), "utf8")) : {};

async function gh<T>(path: string): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(`https://api.github.com/${path}`, { headers: { accept: "application/vnd.github+json", ...(token ? { authorization: `Bearer ${token}` } : {}) } });
    if (r.ok) return (await r.json()) as T;
    if (attempt < 3 && (r.status === 403 || r.status >= 500)) { await new Promise((s) => setTimeout(s, 2000 * (attempt + 1))); continue; }
    throw new Error(`GET ${path}: ${r.status}`);
  }
}

const STOP = new Set("the a an of in on to for with is are be by and or not if causing causes using use from without instead".split(" "));
export const terms = (s: string) => [...new Set((s.toLowerCase().match(/[a-z_][a-z0-9_.?]+/g) ?? []).filter((w) => w.length > 2 && !STOP.has(w)))];
/** Pick the comment whose text best overlaps the bug description (ties: the published-winner tool first). */
export function bestComment(bug: string, comments: Comment[]): Comment | undefined {
  const t = terms(bug);
  const score = (c: Comment) => t.filter((w) => c.body.toLowerCase().includes(w)).length;
  return [...comments].sort((a, b) => score(b) - score(a))[0];
}

async function main() {
  const dataset = { version: "greptile-50@2025-07", source: "https://www.greptile.com/benchmarks", cases: [] as unknown[] };
  for (const c of table.cases.filter((x) => !only || x.repo === only)) {
    const fork = `ai-code-review-evaluation/${c.repo}-greptile`;
    const pr = await gh<{ base: { sha: string; ref: string }; head: { sha: string }; changed_files: number }>(`repos/${fork}/pulls/${c.forkPr}`);
    const comments: Comment[] = [];
    for (const tool of table.tools.filter((t) => c.published[t])) {
      const rc = await gh<{ path: string; line: number | null; original_line: number | null; start_line: number | null; body: string; user: { login: string } }[]>(
        `repos/ai-code-review-evaluation/${c.repo}-${tool}/pulls/${c.toolPrs[tool]}/comments?per_page=100`);
      for (const x of rc) {
        const line = x.line ?? x.original_line;
        if (line && x.user.login.toLowerCase().includes("bot") || line && tool !== "greptile") comments.push({ tool, path: x.path, line: line!, ...(x.start_line ? { startLine: x.start_line } : {}), body: x.body.slice(0, 1500) });
      }
    }
    const human = labels[c.id];
    const best = human ? undefined : bestComment(c.bug, comments);
    const loc = human ?? (best ? { path: best.path, startLine: best.startLine ?? best.line, endLine: best.line } : undefined);
    dataset.cases.push({
      id: c.id, repo: `https://github.com/${fork}`, forkPr: c.forkPr, baseSha: pr.base.sha, headSha: pr.head.sha, baseRef: pr.base.ref, changedFiles: pr.changed_files,
      language: c.language, license: c.license, provenance: "real-fix-commit", publishedSeverity: c.severity, published: c.published,
      labelSource: human ? "human" : best ? `auto:${best.tool}-comment` : "unlabelled",
      bugs: [{ id: `${c.id}-b1`, category: /inject|ssrf|timing|vulnerab|bypass|backup codes/i.test(c.bug) ? "security" : "bug", severity: c.severity, description: c.bug,
        location: loc ?? { path: "UNLABELLED", startLine: 1, endLine: 1 }, ...(human?.acceptAlso ? { acceptAlso: human.acceptAlso } : {}), keyTerms: terms(c.bug).slice(0, 8) }],
      labelCandidates: comments.map(({ tool, path, line, body }) => ({ tool, path, line, excerpt: body.slice(0, 300) })),
    });
    console.error(`${c.id} ${pr.head.sha.slice(0, 8)} files=${pr.changed_files} comments=${comments.length} label=${loc ? `${loc.path}:${loc.startLine}` : "none"}`);
  }
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(dataset, null, 1) + "\n");
  console.error(`wrote ${dataset.cases.length} cases to ${out}`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
