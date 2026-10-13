import { execFile, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { createHash, randomUUID } from "node:crypto";
import { promisify } from "node:util";
import type { Message } from "@review/core";
import type { EnvelopeCipher } from "@review/crypto";
import { branchHead, createIndexRecord, getIndexRecord, latestReadyIndex, readyIndexForCommit, setBranchHead, updateIndexRecord, withTenant, EMBEDDING_DIM, type Database, type Sql } from "@review/db";
import type { ModelRouter } from "@review/models";
import { tenantKey } from "@review/queue";
import type { ObjectStore } from "@review/service-common";
import { chunkFile, type Chunk } from "./chunk.ts";
import { detectLanguage, parseSource, type ParsedFile } from "./parse.ts";

export interface RepoFile { path: string; blobSha: string; size?: number }
export interface GrepHit { path: string; line: number; text: string }
/** globs: git pathspec globs (e.g. "*.py") limiting the search. */
export interface GrepOptions { maxHits?: number; ignoreCase?: boolean; globs?: string[] }
export interface RepoSource {
  listFiles(commitSha: string): Promise<RepoFile[]>;
  readBlob(blobSha: string): Promise<Buffer>;
  /** Extended-regex line search at a commit (optional; LocalCodeIndex falls back to scanning files). */
  grep?(commitSha: string, pattern: string, opts?: GrepOptions): Promise<GrepHit[]>;
}
export interface IndexerDeps { db: Database; store: ObjectStore; cipher: EnvelopeCipher; router: ModelRouter; source: RepoSource }
export interface IndexResult { indexId: string; status: "ready"; files: number; parsed: number; reused: number; embedded: number; symbols: number; chunks: number }

export const MAX_FILE_BYTES = 1_000_000;
const SKIP_DIR = /(^|\/)(node_modules|dist|vendor|build|\.git)\//;
const BINARY_EXT = /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tgz|jar|wasm|so|dylib|dll|exe|bin|woff2?|ttf|mp[34]|mov|lock)$/i;
export const acceptPath = (p: string) => !SKIP_DIR.test(p) && !BINARY_EXT.test(p);
const EMBED_BATCH = 64;

/** Map-backed source: commit -> files, blob sha -> content. */
export function memoryRepoSource(commits: Record<string, Record<string, string>>): RepoSource & { reads: string[] } {
  const blobs = new Map<string, Buffer>();
  const trees = new Map<string, RepoFile[]>();
  for (const [sha, files] of Object.entries(commits)) {
    trees.set(sha, Object.entries(files).map(([path, content]) => {
      const b = Buffer.from(content);
      const blobSha = gitBlobSha(b);
      blobs.set(blobSha, b);
      return { path, blobSha, size: b.length };
    }));
  }
  const reads: string[] = [];
  return {
    reads,
    async listFiles(c) { const t = trees.get(c); if (!t) throw new Error(`unknown commit ${c}`); return t; },
    async readBlob(s) { reads.push(s); const b = blobs.get(s); if (!b) throw new Error(`unknown blob ${s}`); return b; },
  };
}

const gitBlobSha = (b: Buffer) => createHash("sha1").update(`blob ${b.length}\0`).update(b).digest("hex");

const exec = promisify(execFile);
const SHA = /^[0-9a-f]{7,64}$/;

/** Local clone source via git plumbing (execFile, no shell; shas validated so they cannot become options). */
export function gitRepoSource(dir: string): RepoSource {
  return {
    async listFiles(commitSha) {
      if (!SHA.test(commitSha)) throw new Error("invalid commit sha");
      const { stdout } = await exec("git", ["-C", dir, "ls-tree", "-r", "-z", "--long", commitSha], { maxBuffer: 256 << 20 });
      return stdout.split("\0").filter(Boolean).flatMap((l) => {
        const m = /^\d+ blob ([0-9a-f]+)\s+(\d+|-)\t(.*)$/s.exec(l);
        return m ? [{ blobSha: m[1]!, size: Number(m[2]), path: m[3]! }] : [];
      });
    },
    async grep(commitSha, pattern, opts = {}) {
      if (!SHA.test(commitSha)) throw new Error("invalid commit sha");
      // -e keeps the pattern from being read as an option; exit 1 (no match) is not an error.
      const args = ["-C", dir, "grep", "-n", "-I", "-E", "--full-name", ...(opts.ignoreCase ? ["-i"] : []), "-e", pattern, commitSha, ...(opts.globs?.length ? ["--", ...opts.globs.filter((g) => /^[\w*./-]+$/.test(g))] : [])];
      const max = opts.maxHits ?? 2000;
      const hits: GrepHit[] = [];
      // Streamed and stopped at maxHits: a common name on a large repo used to overflow execFile's 64 MB buffer (review R7).
      const child = spawn("git", args, { stdio: ["ignore", "pipe", "pipe"] });
      let stderr = "", truncated = false;
      child.stderr.on("data", (d: Buffer) => { if (stderr.length < 4000) stderr += d.toString(); });
      const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
      for await (const l of lines) {
        const m = /^[0-9a-f]+:([^:]+):(\d+):(.*)$/.exec(l);
        if (m) hits.push({ path: m[1]!, line: Number(m[2]), text: m[3]!.slice(0, 400) });
        if (hits.length >= max) { truncated = true; lines.close(); child.kill(); break; }
      }
      const code = child.exitCode ?? await new Promise<number | null>((r) => child.once("close", r));
      if (!truncated && code !== 0 && code !== 1) throw new Error(`git grep failed (exit ${code}): ${stderr.slice(0, 200)}`);
      return hits;
    },
    async readBlob(blobSha) {
      if (!SHA.test(blobSha)) throw new Error("invalid blob sha");
      const { stdout } = await exec("git", ["-C", dir, "cat-file", "blob", blobSha], { encoding: "buffer", maxBuffer: MAX_FILE_BYTES * 2 });
      return stdout;
    },
  };
}

interface NewFile { path: string; blobSha: string; language: string | null; parsed: ParsedFile | undefined; chunks: Chunk[] }
const vec = (v: number[]) => `[${v.join(",")}]`;

export async function indexRepository(deps: IndexerDeps, msg: Message<"index.requested">): Promise<IndexResult> {
  const { tenantId, payload: p } = msg;
  const embedModel = deps.router.policy.embed[0]!.model;
  // Standing index: a commit that is already indexed is never rebuilt; a push only moves the branch head.
  const existing = p.mode === "full" ? undefined : await withTenant(deps.db, tenantId, async (sql) => {
    const r = await readyIndexForCommit(sql, p.repositoryId, p.commitSha);
    if (r && p.branch) await setBranchHead(sql, tenantId, { repositoryId: p.repositoryId, branch: p.branch, indexId: r.id, commitSha: p.commitSha });
    // The API created a pending record for this request; resolve it to the existing index's counts so GET never stays pending (review R3).
    if (r && p.indexId && p.indexId !== r.id && await getIndexRecord(sql, p.indexId)) {
      await sql.query("UPDATE repo_indexes SET base_index_id = $2 WHERE id = $1", [p.indexId, r.id]);
      await updateIndexRecord(sql, p.indexId, { status: "ready", languages: r.languages, fileCount: r.fileCount, symbolCount: r.symbolCount, chunkCount: r.chunkCount });
    }
    return r;
  });
  if (existing) return { indexId: existing.id, status: "ready", files: existing.fileCount, parsed: 0, reused: existing.fileCount, embedded: 0, symbols: existing.symbolCount, chunks: existing.chunkCount };
  const indexId = p.indexId ?? randomUUID();
  const base = await withTenant(deps.db, tenantId, async (sql) => {
    const b = p.mode === "full" ? undefined : p.baseIndexId ? await getIndexRecord(sql, p.baseIndexId)
      : (p.branch ? await branchHead(sql, p.repositoryId, p.branch) : undefined) ?? await latestReadyIndex(sql, p.repositoryId);
    await createIndexRecord(sql, tenantId, { id: indexId, repositoryId: p.repositoryId, commitSha: p.commitSha, embedModel, ...(b ? { baseIndexId: b.id } : {}) });
    await updateIndexRecord(sql, indexId, { status: "building" });
    return b?.status === "ready" ? b : undefined;
  });
  try {
    const r = await build(deps, tenantId, indexId, p.commitSha, base?.id, embedModel);
    if (p.branch) await withTenant(deps.db, tenantId, (sql) => setBranchHead(sql, tenantId, { repositoryId: p.repositoryId, branch: p.branch!, indexId, commitSha: p.commitSha }));
    return r;
  } catch (e) {
    await withTenant(deps.db, tenantId, (sql) => updateIndexRecord(sql, indexId, { status: "failed" }));
    throw e;
  }
}

async function build(deps: IndexerDeps, tenantId: string, indexId: string, commitSha: string, baseId: string | undefined, embedModel: string): Promise<IndexResult> {
  const files = (await deps.source.listFiles(commitSha)).filter((f) => acceptPath(f.path) && (f.size ?? 0) <= MAX_FILE_BYTES);
  const baseFiles = baseId
    ? new Set((await withTenant(deps.db, tenantId, (sql) => sql.query<{ path: string; blob_sha: string }>("SELECT path, blob_sha FROM index_files WHERE index_id = $1", [baseId]))).rows.map((r) => `${r.path}\0${r.blob_sha}`))
    : new Set<string>();
  // Unchanged = same path and blob (fqNames embed the path, so a moved blob is re-parsed).
  const reused = files.filter((f) => baseFiles.has(`${f.path}\0${f.blobSha}`));
  const changed = files.filter((f) => !baseFiles.has(`${f.path}\0${f.blobSha}`));

  const fresh: NewFile[] = [];
  for (const f of changed) {
    const buf = await deps.source.readBlob(f.blobSha);
    if (buf.length > MAX_FILE_BYTES || buf.subarray(0, 8000).includes(0)) continue;
    await deps.store.put(tenantKey(tenantId, "blobs", f.blobSha), await deps.cipher.encrypt(tenantId, buf, `blob:${f.blobSha}`));
    const src = buf.toString("utf8");
    const lang = detectLanguage(f.path);
    const parsed = lang ? await parseSource(f.path, src, lang) : undefined;
    // ponytail: only parseable languages are chunked/embedded; plain text files (md, yaml) are stored but not searchable yet.
    fresh.push({ path: f.path, blobSha: f.blobSha, language: lang ?? null, parsed, chunks: parsed ? chunkFile(f.path, src, parsed) : [] });
  }

  const embeddings = await embedAll(deps, tenantId, embedModel, fresh.flatMap((f) => f.chunks));
  const encrypted = await Promise.all(fresh.map((f) => Promise.all(f.chunks.map((c) => deps.cipher.encrypt(tenantId, c.text, "chunk")))));

  const counts = await withTenant(deps.db, tenantId, async (sql) => {
    for (const f of reused) await insertFile(sql, tenantId, indexId, f.path, f.blobSha, detectLanguage(f.path) ?? null);
    if (baseId && reused.length) await copyFromBase(sql, tenantId, baseId, indexId, reused.map((f) => f.path));
    for (const [i, f] of fresh.entries()) {
      await insertFile(sql, tenantId, indexId, f.path, f.blobSha, f.language);
      const ids = new Map<string, string>();
      for (const e of f.parsed?.entities ?? []) {
        const id = randomUUID();
        ids.set(e.fqName, id);
        await sql.query("INSERT INTO symbols (id, tenant_id, index_id, blob_sha, path, kind, name, fq_name, start_line, end_line) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
          [id, tenantId, indexId, f.blobSha, f.path, e.kind, e.name, e.fqName, e.startLine, e.endLine]);
      }
      for (const e of f.parsed?.edges ?? []) {
        await sql.query("INSERT INTO symbol_edges (tenant_id, index_id, src_symbol_id, path, kind, dst_name, line) VALUES ($1,$2,$3,$4,$5,$6,$7)",
          [tenantId, indexId, e.src ? ids.get(e.src) ?? null : null, f.path, e.kind, e.dstName, e.line]);
      }
      for (const [j, c] of f.chunks.entries()) {
        await sql.query(`INSERT INTO chunks (tenant_id, index_id, symbol_id, path, start_line, end_line, blob_sha, content_hash, content_ciphertext, tsv, embedding)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, to_tsvector('simple', $10), $11::vector)`,
          [tenantId, indexId, c.symbolFq ? ids.get(c.symbolFq) ?? null : null, c.path, c.startLine, c.endLine, f.blobSha, c.contentHash, encrypted[i]![j]!, lexicalText(c.embedText), vec(embeddings.get(c.contentHash)!)]);
      }
    }
    // Resolve call targets by name within the index. ponytail: name-only resolution; add import-aware resolution later.
    await sql.query(`UPDATE symbol_edges e SET dst_symbol_id = (SELECT s.id FROM symbols s WHERE s.index_id = e.index_id AND s.name = e.dst_name ORDER BY s.fq_name LIMIT 1)
      WHERE e.index_id = $1 AND e.kind = 'call'`, [indexId]);
    const n = (await sql.query<{ s: number; c: number; l: string[] | null }>(`SELECT (SELECT count(*)::int FROM symbols WHERE index_id = $1) s, (SELECT count(*)::int FROM chunks WHERE index_id = $1) c,
      (SELECT array_agg(DISTINCT language) FROM index_files WHERE index_id = $1 AND language IS NOT NULL) l`, [indexId])).rows[0]!;
    await updateIndexRecord(sql, indexId, { status: "ready", fileCount: reused.length + fresh.length, symbolCount: n.s, chunkCount: n.c, languages: n.l ?? [] });
    return n;
  });
  return { indexId, status: "ready", files: reused.length + fresh.length, parsed: fresh.filter((f) => f.parsed).length, reused: reused.length, embedded: embeddings.embedded, symbols: counts.s, chunks: counts.c };
}

/** Split camelCase / snake_case so lexical search matches identifier parts as well as whole identifiers. */
export const lexicalText = (s: string) => `${s} ${s.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/_/g, " ")}`.toLowerCase();

const insertFile = (sql: Sql, tenantId: string, indexId: string, path: string, blobSha: string, language: string | null) =>
  sql.query("INSERT INTO index_files (tenant_id, index_id, path, blob_sha, language, object_key) VALUES ($1,$2,$3,$4,$5,$6)",
    [tenantId, indexId, path, blobSha, language, tenantKey(tenantId, "blobs", blobSha)]);

/** Copy symbols, edges and chunks (incl. embeddings + ciphertext) of unchanged files, remapping symbol ids. */
async function copyFromBase(sql: Sql, tenantId: string, baseId: string, indexId: string, paths: string[]) {
  await sql.query("CREATE TEMP TABLE IF NOT EXISTS _symmap (old text PRIMARY KEY, new text NOT NULL) ON COMMIT DROP");
  await sql.query("INSERT INTO _symmap SELECT id, gen_random_uuid()::text FROM symbols WHERE index_id = $1 AND path = ANY($2)", [baseId, paths]);
  await sql.query(`INSERT INTO symbols (id, tenant_id, index_id, blob_sha, path, kind, name, fq_name, start_line, end_line)
    SELECT m.new, $3, $2, s.blob_sha, s.path, s.kind, s.name, s.fq_name, s.start_line, s.end_line FROM symbols s JOIN _symmap m ON m.old = s.id WHERE s.index_id = $1`, [baseId, indexId, tenantId]);
  await sql.query(`INSERT INTO symbol_edges (tenant_id, index_id, src_symbol_id, path, kind, dst_name, line)
    SELECT $3, $2, m.new, e.path, e.kind, e.dst_name, e.line FROM symbol_edges e LEFT JOIN _symmap m ON m.old = e.src_symbol_id WHERE e.index_id = $1 AND e.path = ANY($4)`, [baseId, indexId, tenantId, paths]);
  await sql.query(`INSERT INTO chunks (tenant_id, index_id, symbol_id, path, start_line, end_line, blob_sha, content_hash, content_ciphertext, tsv, embedding)
    SELECT $3, $2, m.new, c.path, c.start_line, c.end_line, c.blob_sha, c.content_hash, c.content_ciphertext, c.tsv, c.embedding
    FROM chunks c LEFT JOIN _symmap m ON m.old = c.symbol_id WHERE c.index_id = $1 AND c.path = ANY($4)`, [baseId, indexId, tenantId, paths]);
}

/** Embeddings by content_hash: embedding_cache first, router.embed for misses (batched), cache written back. */
async function embedAll(deps: IndexerDeps, tenantId: string, model: string, chunks: Chunk[]): Promise<Map<string, number[]> & { embedded: number }> {
  const out = Object.assign(new Map<string, number[]>(), { embedded: 0 });
  const hashes = [...new Set(chunks.map((c) => c.contentHash))];
  if (!hashes.length) return out;
  const cached = await withTenant(deps.db, tenantId, (sql) => sql.query<{ content_hash: string; embedding: string }>(
    "SELECT content_hash, embedding::text AS embedding FROM embedding_cache WHERE model = $1 AND content_hash = ANY($2)", [model, hashes]));
  for (const r of cached.rows) out.set(r.content_hash, JSON.parse(r.embedding) as number[]);
  const miss = new Map<string, string>();
  for (const c of chunks) if (!out.has(c.contentHash)) miss.set(c.contentHash, c.embedText);
  const todo = [...miss];
  for (let i = 0; i < todo.length; i += EMBED_BATCH) {
    const batch = todo.slice(i, i + EMBED_BATCH);
    const r = await deps.router.embed(batch.map(([, t]) => t), { scope: { tenantId } });
    if (r.dimensions !== EMBEDDING_DIM) throw new Error(`embedding dimension ${r.dimensions} != ${EMBEDDING_DIM}`);
    out.embedded += batch.length;
    await withTenant(deps.db, tenantId, async (sql) => {
      for (const [j, [h]] of batch.entries()) {
        out.set(h, r.vectors[j]!);
        await sql.query("INSERT INTO embedding_cache (tenant_id, model, content_hash, embedding) VALUES ($1,$2,$3,$4::vector) ON CONFLICT DO NOTHING", [tenantId, model, h, vec(r.vectors[j]!)]);
      }
    });
  }
  return out;
}
