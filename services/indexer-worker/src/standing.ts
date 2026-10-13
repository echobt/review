import { BlobCache, LocalCodeIndex, type CodeIndex } from "./local-index.ts";
import { acceptPath, MAX_FILE_BYTES, type RepoSource } from "./indexer.ts";
import { detectLanguage } from "./parse.ts";

export interface IndexEntry { repositoryId: string; commitSha: string; index: CodeIndex; createdAt: number }
export interface UpdateResult { commitSha: string; files: number; changed: number; reused: number; warmed: Promise<number> }

interface RepoState { cache: BlobCache; commits: Map<string, IndexEntry>; trees: Map<string, Promise<Map<string, string>>>; branches: Map<string, string> }

/**
 * Standing per-repository index (LATENCY-PLAN §2): one blob-SHA-keyed cache per repository, shared by every commit and
 * every PR, plus a per-branch head pointer moved on push. A review calls ensureIndexed(repo, headSha): a known commit is
 * returned as-is; a new commit reuses every unchanged blob's text and parse tree, so only changed blobs are read.
 * Cold start (first index of a repo) is a background warm-up; ensureIndexed never waits for it.
 * ponytail: per-process memory; the Postgres index (indexRepository + branch_heads) is the cross-process store.
 */
export class StandingIndex {
  readonly #source: (repositoryId: string) => RepoSource;
  readonly #repos = new Map<string, RepoState>();
  readonly #maxCommits: number;
  readonly #maxBytes: number;
  readonly #warmWidth: number;
  /** How many times a commit view was created (a cache hit does not count). Tests assert reuse with it. */
  builds = 0;

  constructor(source: (repositoryId: string) => RepoSource, opts: { maxCommitsPerRepo?: number; maxBytesPerRepo?: number; warmConcurrency?: number } = {}) {
    this.#source = source;
    this.#maxCommits = opts.maxCommitsPerRepo ?? 16;
    this.#maxBytes = opts.maxBytesPerRepo ?? 256 << 20;
    this.#warmWidth = opts.warmConcurrency ?? 4;
  }

  #repo(id: string): RepoState {
    let r = this.#repos.get(id);
    if (!r) { r = { cache: new BlobCache(this.#maxBytes), commits: new Map(), trees: new Map(), branches: new Map() }; this.#repos.set(id, r); }
    return r;
  }

  #tree(r: RepoState, src: RepoSource, sha: string) {
    let t = r.trees.get(sha);
    if (!t) {
      t = src.listFiles(sha).then((fs) => new Map(fs.filter((f) => acceptPath(f.path) && (f.size ?? 0) <= MAX_FILE_BYTES).map((f) => [f.path, f.blobSha])));
      t.catch(() => r.trees.delete(sha));
      r.trees.set(sha, t);
    }
    return t;
  }

  /** Lookup API: the index of repo@sha if it exists (no build). */
  lookup(repositoryId: string, commitSha: string): IndexEntry | undefined { return this.#repos.get(repositoryId)?.commits.get(commitSha); }

  /** Lookup API: the current head of a tracked branch. */
  head(repositoryId: string, branch: string): IndexEntry | undefined {
    const r = this.#repos.get(repositoryId);
    const sha = r?.branches.get(branch);
    return sha ? r!.commits.get(sha) : undefined;
  }

  async ensureIndexed(repositoryId: string, headSha: string): Promise<CodeIndex> {
    const r = this.#repo(repositoryId);
    const hit = r.commits.get(headSha);
    if (hit) { r.commits.delete(headSha); r.commits.set(headSha, hit); return hit.index; }
    const src = this.#source(repositoryId);
    const index = new LocalCodeIndex(src, headSha, { cache: r.cache, files: this.#tree(r, src, headSha) });
    this.builds++;
    r.commits.set(headSha, { repositoryId, commitSha: headSha, index, createdAt: Date.now() });
    // Evict least-recently-used commit views, never a branch head.
    const heads = new Set(r.branches.values());
    for (const old of [...r.commits.keys()]) {
      if (r.commits.size <= this.#maxCommits) break;
      if (heads.has(old) || old === headSha) continue;
      r.commits.delete(old); r.trees.delete(old);
    }
    return index;
  }

  /**
   * Update API (push webhook): move the branch head to `commitSha`. Blobs whose SHA the repo already parsed are reused;
   * only new source blobs are parsed, in the background (`warmed` resolves with the number parsed).
   */
  async update(repositoryId: string, branch: string, commitSha: string): Promise<UpdateResult> {
    const r = this.#repo(repositoryId);
    const prev = r.branches.get(branch);
    const ix = await this.ensureIndexed(repositoryId, commitSha);
    const tree = await this.#tree(r, this.#source(repositoryId), commitSha);
    const before = prev ? await r.trees.get(prev)?.catch(() => undefined) : undefined;
    const changed = [...tree].filter(([p, sha]) => before?.get(p) !== sha).map(([p]) => p);
    r.branches.set(branch, commitSha);
    return { commitSha, files: tree.size, changed: changed.length, reused: tree.size - changed.length, warmed: this.warm(ix, changed) };
  }

  /** Cold start / push warm-up off the critical path: parse source files with bounded concurrency. Errors are per file. */
  async warm(ix: CodeIndex, paths?: string[]): Promise<number> {
    const todo = (paths ?? (await ix.paths())).filter((p) => detectLanguage(p));
    let i = 0, n = 0;
    await Promise.all(Array.from({ length: Math.min(this.#warmWidth, todo.length) }, async () => {
      while (i < todo.length) { const p = todo[i++]!; if (await ix.parse(p).catch(() => undefined)) n++; }
    }));
    return n;
  }

  /** Invalidation API: drop one branch head, or the whole repository (e.g. force-push, repo removed, model change). */
  invalidate(repositoryId: string, branch?: string): void {
    if (branch === undefined) { this.#repos.delete(repositoryId); return; }
    this.#repos.get(repositoryId)?.branches.delete(branch);
  }

  stats(repositoryId: string) {
    const r = this.#repos.get(repositoryId);
    return r ? { commits: r.commits.size, branches: Object.fromEntries(r.branches), cache: { ...r.cache.stats, ...r.cache.size } } : undefined;
  }
}
