import { hashEmbeddings } from "@review/models";
import type { GrepHit, GrepOptions, RepoSource } from "./indexer.ts";
import { acceptPath, MAX_FILE_BYTES } from "./indexer.ts";
import { detectLanguage, parseSource, type Entity, type ParsedFile } from "./parse.ts";
import { rrf } from "./retrieval.ts";

export interface SymbolDef { name: string; kind: string; path: string; startLine: number; endLine: number; text: string; bases?: string[]; abstract?: boolean; parent?: string }
export interface SearchHit { path: string; startLine: number; endLine: number; text: string; score: number; via: ("lexical" | "vector" | "graph")[] }

/** Read-only view of one repository at one commit, used by the context pack and the agent tools. */
export interface CodeIndex {
  readonly commitSha: string;
  paths(): Promise<string[]>;
  readFile(path: string): Promise<string | undefined>;
  parse(path: string): Promise<ParsedFile | undefined>;
  definitions(name: string, opts?: { limit?: number; preferPaths?: string[]; globs?: string[] }): Promise<SymbolDef[]>;
  /** One grep for many names (much cheaper than N calls on large repos). */
  definitionsMany(names: string[], opts?: { limit?: number; preferPaths?: string[]; globs?: string[] }): Promise<Map<string, SymbolDef[]>>;
  referencesMany(names: string[], opts?: { limit?: number; globs?: string[] }): Promise<Map<string, GrepHit[]>>;
  /** Members (methods) declared inside a class definition. */
  members(def: SymbolDef): Promise<SymbolDef[]>;
  references(name: string, opts?: { limit?: number; globs?: string[] }): Promise<GrepHit[]>;
  grep(pattern: string, opts?: GrepOptions): Promise<GrepHit[]>;
  search(query: string, opts?: { k?: number; seeds?: string[]; globs?: string[] }): Promise<SearchHit[]>;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export const MAX_DEF_LINES = 80;
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Declaration-shaped lines for any of the names, across Python/TS/JS/Go/Java/Ruby/Rust (confirmed afterwards with tree-sitter). */
export function declPattern(names: string[]): string {
  const alt = names.filter((n) => IDENT.test(n)).map(esc).join("|");
  return [
    `(def|class|function\\*?|func|interface|type|enum|struct|trait|module|record)[[:space:]]+(self\\.)?(${alt})([^A-Za-z0-9_]|$)`,
    `func[[:space:]]+\\([^)]*\\)[[:space:]]*(${alt})[[:space:]]*\\(`,
    `^[[:space:]]*(export[[:space:]]+)?(const|let|var)[[:space:]]+(${alt})[[:space:]]*[=:]`,
    `^(${alt})[[:space:]]*(:[^=]*)?=[^=]`,
    // Java/C-style method: a return type token right before the name (so `x = Foo()` / bare `Foo()` calls are not declarations).
    `[A-Za-z0-9_>\\]][[:space:]]+(${alt})[[:space:]]*\\([^;]*\\)[[:space:]]*(throws[[:space:]][A-Za-z0-9_., ]+)?\\{?[[:space:]]*$`,
  ].join("|");
}

const isTest = (p: string) => /(^|\/)(tests?|spec|__tests__)\/|(_test|\.test|\.spec|_spec)\.[a-z]+$|(^|\/)test_[^/]*$/.test(p);
export { isTest as isTestPath };

/** Okapi BM25 over a small candidate pool (k1=1.2, b=0.75). */
export function bm25(docs: string[], terms: string[]): number[] {
  const toks = docs.map((d) => (d.toLowerCase().match(/[a-z0-9_]+/g) ?? []).flatMap((w) => [w, ...w.split("_").filter((x) => x && x !== w)]));
  const avg = toks.reduce((s, t) => s + t.length, 0) / Math.max(1, toks.length);
  const q = terms.map((t) => t.toLowerCase());
  const df = new Map(q.map((t) => [t, toks.filter((d) => d.includes(t)).length]));
  return toks.map((d) => q.reduce((s, t) => {
    const tf = d.filter((w) => w === t).length;
    if (!tf) return s;
    const idf = Math.log(1 + (toks.length - df.get(t)! + 0.5) / (df.get(t)! + 0.5));
    return s + idf * (tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * d.length / avg));
  }, 0));
}

const cosine = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i]!, 0);

/**
 * In-process index over a RepoSource at one commit. Lazy: nothing is read until asked; grep narrows candidates and
 * tree-sitter confirms definitions. ponytail: no SCIP here; ScipIndex (scip.ts) overlays precise definitions when a SCIP dump exists.
 */
export class LocalCodeIndex implements CodeIndex {
  readonly commitSha: string;
  readonly #src: RepoSource;
  #files?: Promise<Map<string, string>>;
  readonly #text = new Map<string, Promise<string | undefined>>();
  readonly #parsed = new Map<string, Promise<ParsedFile | undefined>>();

  constructor(source: RepoSource, commitSha: string) { this.#src = source; this.commitSha = commitSha; }

  #tree() {
    return this.#files ??= this.#src.listFiles(this.commitSha).then((fs) => new Map(fs.filter((f) => acceptPath(f.path) && (f.size ?? 0) <= MAX_FILE_BYTES).map((f) => [f.path, f.blobSha])));
  }
  async paths() { return [...(await this.#tree()).keys()]; }

  readFile(path: string) {
    let p = this.#text.get(path);
    if (!p) {
      p = this.#tree().then(async (t) => {
        const sha = t.get(path);
        if (!sha) return undefined;
        const b = await this.#src.readBlob(sha);
        return b.subarray(0, 8000).includes(0) ? undefined : b.toString("utf8");
      });
      this.#text.set(path, p);
    }
    return p;
  }

  parse(path: string) {
    let p = this.#parsed.get(path);
    if (!p) { p = this.readFile(path).then((t) => (t === undefined ? undefined : parseSource(path, t))); this.#parsed.set(path, p); }
    return p;
  }

  async grep(pattern: string, opts: GrepOptions = {}): Promise<GrepHit[]> {
    if (this.#src.grep) return (await this.#src.grep(this.commitSha, pattern, opts)).filter((h) => acceptPath(h.path));
    const re = new RegExp(pattern.replace(/\[\[:space:\]\]/g, "\\s"), opts.ignoreCase ? "i" : "");
    const hits: GrepHit[] = [];
    const exts = (opts.globs ?? []).map((g) => g.replace(/^\*+/, ""));
    for (const path of await this.paths()) {
      if (exts.length && !exts.some((e) => path.endsWith(e))) continue;
      const t = await this.readFile(path);
      if (!t) continue;
      t.split("\n").forEach((text, i) => { if (re.test(text) && hits.length < (opts.maxHits ?? 2000)) hits.push({ path, line: i + 1, text: text.slice(0, 400) }); });
    }
    return hits;
  }

  #toDef(path: string, e: Entity, text: string): SymbolDef {
    const lines = text.split("\n").slice(e.startLine - 1, Math.min(e.endLine, e.startLine - 1 + MAX_DEF_LINES));
    return { name: e.name, kind: e.kind, path, startLine: e.startLine, endLine: e.endLine, text: lines.join("\n"),
      ...(e.bases ? { bases: e.bases } : {}), ...(e.abstract ? { abstract: true } : {}), ...(e.parent ? { parent: e.parent } : {}) };
  }

  async definitions(name: string, opts: { limit?: number; preferPaths?: string[]; globs?: string[] } = {}): Promise<SymbolDef[]> {
    return (await this.definitionsMany([name], opts)).get(name) ?? [];
  }

  async definitionsMany(names: string[], opts: { limit?: number; preferPaths?: string[]; globs?: string[] } = {}): Promise<Map<string, SymbolDef[]>> {
    const want = [...new Set(names.filter((n) => IDENT.test(n)))];
    const out = new Map<string, SymbolDef[]>(want.map((n) => [n, []]));
    if (!want.length) return out;
    const limit = opts.limit ?? 5, pref = opts.preferPaths ?? [];
    const hits = await this.grep(declPattern(want), { maxHits: 4000, ...(opts.globs ? { globs: opts.globs } : {}) });
    const wordsIn = (t: string) => new Set(t.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []);
    const filesFor = new Map<string, Set<string>>(want.map((n) => [n, new Set()]));
    for (const h of hits) { const w = wordsIn(h.text); for (const n of want) if (w.has(n)) filesFor.get(n)!.add(h.path); }
    const order = (a: string, b: string) => Number(pref.includes(b)) - Number(pref.includes(a)) || Number(isTest(a)) - Number(isTest(b)) || a.length - b.length || a.localeCompare(b);
    for (const n of want) {
      const defs = out.get(n)!;
      for (const path of [...filesFor.get(n)!].sort(order).slice(0, 25)) {
        const [p, t] = await Promise.all([this.parse(path), this.readFile(path)]);
        if (!p || t === undefined) continue;
        for (const e of p.entities) if (e.name === n && defs.length < limit) defs.push(this.#toDef(path, e, t));
        if (defs.length >= limit) break;
      }
    }
    return out;
  }

  async members(def: SymbolDef): Promise<SymbolDef[]> {
    const [p, t] = await Promise.all([this.parse(def.path), this.readFile(def.path)]);
    if (!p || t === undefined) return [];
    return p.entities.filter((e) => e.kind === "method" && e.startLine > def.startLine && e.endLine <= def.endLine && (e.parent === def.name || e.parent === undefined))
      .map((e) => this.#toDef(def.path, e, t));
  }

  async references(name: string, opts: { limit?: number; globs?: string[] } = {}): Promise<GrepHit[]> {
    return (await this.referencesMany([name], opts)).get(name) ?? [];
  }

  async referencesMany(names: string[], opts: { limit?: number; globs?: string[] } = {}): Promise<Map<string, GrepHit[]>> {
    const want = [...new Set(names.filter((n) => IDENT.test(n)))];
    const out = new Map<string, GrepHit[]>(want.map((n) => [n, []]));
    if (!want.length) return out;
    const hits = await this.grep(`(^|[^A-Za-z0-9_])(${want.map(esc).join("|")})([^A-Za-z0-9_]|$)`, { maxHits: 6000, ...(opts.globs ? { globs: opts.globs } : {}) });
    for (const n of want) {
      const word = new RegExp(`(^|[^A-Za-z0-9_])${esc(n)}([^A-Za-z0-9_]|$)`);
      const decl = new RegExp(declPattern([n]).replace(/\[\[:space:\]\]/g, "\\s"));
      const call = new RegExp(`${esc(n)}\\s*\\(`);
      // Call sites first, then tests, then other mentions; declarations and import lines are not references.
      const rank = (h: GrepHit) => (call.test(h.text) ? 0 : 2) + (isTest(h.path) ? 1 : 0);
      out.set(n, hits.filter((h) => word.test(h.text) && (!decl.test(h.text) || /^\s*(return|yield|await|throw|new|else)\b/.test(h.text)) && !/^\s*(from|import|require|use)\b/.test(h.text))
        .sort((a, b) => rank(a) - rank(b) || a.path.localeCompare(b.path) || a.line - b.line).slice(0, opts.limit ?? 20));
    }
    return out;
  }

  /** Hybrid retrieval over a grep-bounded candidate pool: BM25 (lexical) + hash-embedding cosine (vector) + definitions of seeds (graph), fused with RRF. */
  async search(query: string, opts: { k?: number; seeds?: string[]; globs?: string[] } = {}): Promise<SearchHit[]> {
    const terms = [...new Set((query.match(/[A-Za-z_][A-Za-z0-9_]{2,}/g) ?? []).map((t) => t))].slice(0, 8);
    if (!terms.length) return [];
    const hits = await this.grep(terms.map(esc).join("|"), { maxHits: 1500, ...(opts.globs ? { globs: opts.globs } : {}) });
    // Candidate chunks: the enclosing entity of each hit (or a 20-line window), at most 60 files.
    const byFile = new Map<string, number[]>();
    for (const h of hits) byFile.set(h.path, [...(byFile.get(h.path) ?? []), h.line]);
    const files = [...byFile].sort((a, b) => b[1].length - a[1].length).slice(0, 60);
    const chunks: { path: string; startLine: number; endLine: number; text: string }[] = [];
    const seen = new Set<string>();
    for (const [path, lines] of files) {
      const [p, t] = await Promise.all([this.parse(path), this.readFile(path)]);
      if (t === undefined) continue;
      const src = t.split("\n");
      for (const ln of lines.slice(0, 20)) {
        const ent = (p?.entities ?? []).filter((e) => e.startLine <= ln && e.endLine >= ln && e.endLine - e.startLine < 120).sort((a, b) => (a.endLine - a.startLine) - (b.endLine - b.startLine))[0];
        const s = ent?.startLine ?? Math.max(1, ln - 10), e = ent?.endLine ?? Math.min(src.length, ln + 10);
        const key = `${path}:${s}`;
        if (seen.has(key)) continue;
        seen.add(key);
        chunks.push({ path, startLine: s, endLine: e, text: src.slice(s - 1, e).join("\n") });
      }
    }
    const graph: string[] = [];
    for (const seed of opts.seeds ?? []) for (const d of (await this.definitionsMany(opts.seeds ?? [], { limit: 3, ...(opts.globs ? { globs: opts.globs } : {}) })).get(seed) ?? []) {
      const key = `${d.path}:${d.startLine}`;
      if (!seen.has(key)) { seen.add(key); chunks.push({ path: d.path, startLine: d.startLine, endLine: d.endLine, text: d.text }); }
      graph.push(key);
    }
    if (!chunks.length) return [];
    const ids = chunks.map((c) => `${c.path}:${c.startLine}`);
    const lex = bm25(chunks.map((c) => `${c.path} ${c.text}`), terms);
    const [qv, ...cv] = hashEmbeddings({ model: "local-hash", input: [query, ...chunks.map((c) => c.text)], dimensions: 256 }).vectors;
    const order = (scores: number[]) => scores.map((s, i) => [s, i] as const).filter(([s]) => s > 0).sort((a, b) => b[0] - a[0]).map(([, i]) => ids[i]!);
    const lexical = order(lex), vector = order(cv.map((v) => cosine(qv!, v)));
    const fused = rrf([lexical, vector, graph]).slice(0, opts.k ?? 8);
    return fused.map((f) => {
      const c = chunks[ids.indexOf(f.id)]!;
      const via = ([["lexical", lexical], ["vector", vector], ["graph", graph]] as const).filter(([, l]) => l.includes(f.id)).map(([n]) => n);
      return { ...c, text: c.text.split("\n").slice(0, MAX_DEF_LINES).join("\n"), score: f.score, via };
    });
  }
}
