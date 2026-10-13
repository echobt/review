import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access } from "node:fs/promises";
import { promisify } from "node:util";

const exec = promisify(execFile);
const SHA = /^[0-9a-f]{7,64}$/;
const SAFE_REPO = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)?$/;
/** Blobs above this size stay on the promisor remote (matches indexer MAX_FILE_BYTES; source files are fetched so grep stays local). */
const BLOB_FILTER = "--filter=blob:limit=1m";

export function assertRepoRef(repositoryId: string, sha?: string) {
  if (!SAFE_REPO.test(repositoryId) || repositoryId.includes("..")) throw new Error("invalid repository id");
  if (sha !== undefined && !SHA.test(sha)) throw new Error("invalid sha");
}

/**
 * Working-copy cache (LATENCY-PLAN §6): one bare partial mirror per repository under `root/<repositoryId>`, cloned once
 * (`--filter=blob:limit=1m`, never shallow), fetched incrementally per missing commit, and short-lived `git worktree`s
 * for sandbox checks that share the mirror's object store. No full clone per review.
 */
export class RepoCache {
  readonly root: string;
  readonly #remote: (repositoryId: string) => string | undefined;
  readonly #wsRoot: string;
  readonly #inflight = new Map<string, Promise<void>>();
  readonly counters = { clones: 0, fetches: 0, worktrees: 0 };

  constructor(root: string, opts: { remote?: (repositoryId: string) => string | undefined; workspaceRoot?: string } = {}) {
    this.root = root;
    this.#remote = opts.remote ?? (() => undefined);
    this.#wsRoot = opts.workspaceRoot ?? "/tmp/review-ws";
  }

  dir(repositoryId: string) { assertRepoRef(repositoryId); return `${this.root}/${repositoryId}`; }

  #once(key: string, fn: () => Promise<void>): Promise<void> {
    let p = this.#inflight.get(key);
    if (!p) { p = fn().finally(() => this.#inflight.delete(key)); this.#inflight.set(key, p); }
    return p;
  }

  async ensureMirror(repositoryId: string): Promise<string> {
    const dir = this.dir(repositoryId);
    if (await access(dir).then(() => true, () => false)) return dir;
    const url = this.#remote(repositoryId);
    if (!url) throw new Error(`no mirror for ${repositoryId} and no remote configured`);
    await this.#once(`clone:${repositoryId}`, async () => {
      await exec("git", ["clone", "--bare", BLOB_FILTER, "--no-tags", "--", url, dir], { timeout: 3_600_000 });
      this.counters.clones++;
    });
    return dir;
  }

  async ensureCommit(repositoryId: string, sha: string): Promise<string> {
    assertRepoRef(repositoryId, sha);
    const dir = await this.ensureMirror(repositoryId);
    if (await this.#has(dir, sha)) return dir;
    await this.#once(`fetch:${repositoryId}@${sha}`, async () => {
      if (await this.#has(dir, sha)) return;
      // Partial mirrors keep their filter; full mirrors fetch normally. Never --depth: a shallow mirror loses merge bases.
      const partial = await exec("git", ["-C", dir, "config", "--get", "remote.origin.promisor"]).then((r) => r.stdout.trim() === "true", () => false);
      await exec("git", ["-C", dir, "fetch", "--no-tags", ...(partial ? [BLOB_FILTER] : []), "origin", sha], { timeout: 600_000 });
      this.counters.fetches++;
    });
    return dir;
  }

  // A partial mirror would silently lazy-fetch a missing commit object by object; check locally, then fetch in one go.
  #has(dir: string, sha: string) { return exec("git", ["-C", dir, "cat-file", "-e", `${sha}^{commit}`], { env: { ...process.env, GIT_NO_LAZY_FETCH: "1" } }).then(() => true, () => false); }

  /** Detached worktree of repo@sha for E0-E3; `release` removes it (call in finally). */
  async worktree(repositoryId: string, sha: string): Promise<{ dir: string; release: () => Promise<void> }> {
    const mirror = await this.ensureCommit(repositoryId, sha);
    const dir = `${this.#wsRoot}/${repositoryId.replace("/", "__")}-${sha.slice(0, 12)}-${randomBytes(4).toString("hex")}`;
    await exec("git", ["-C", mirror, "worktree", "add", "--detach", "--force", dir, sha], { timeout: 600_000 });
    this.counters.worktrees++;
    return { dir, release: async () => { await exec("git", ["-C", mirror, "worktree", "remove", "--force", dir]).catch(() => exec("git", ["-C", mirror, "worktree", "prune"])); } };
  }
}
