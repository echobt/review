import { matchesGlob } from "node:path";
import { gitRepoSource, isTestPath, StandingIndex, type CodeIndex, type GrepHit, type SearchHit, type SymbolDef } from "@review/indexer-worker";
import type { DiffFile } from "./plan.ts";
import { languageOf, type ReviewLanguage } from "./languages.ts";
import { createLimiter } from "@review/models";
import { assertRepoRef, RepoCache } from "./repo-cache.ts";

/** GREPTILE-GAP §3.2: the orchestrator asks the indexer for a commit-pinned index before building the pack. */
export interface IndexerPort { ensureIndexed(repositoryId: string, headSha: string): Promise<CodeIndex> }

/**
 * Standing index over cached git mirrors (LATENCY-PLAN §2, §6): RepoCache makes sure repo@sha is present (partial mirror,
 * incremental fetch, no per-review clone), StandingIndex serves one shared blob-keyed index per repository, so a second
 * review of the same repository reuses every unchanged file's read and parse.
 */
export function gitMirrorIndexer(root: string | RepoCache, opts: { fetch?: boolean; standing?: StandingIndex } = {}): IndexerPort & { standing: StandingIndex; repos: RepoCache } {
  const repos = typeof root === "string" ? new RepoCache(root) : root;
  const standing = opts.standing ?? new StandingIndex((id) => gitRepoSource(repos.dir(id)));
  return {
    standing, repos,
    async ensureIndexed(repositoryId, headSha) {
      assertRepoRef(repositoryId, headSha);
      if (!standing.lookup(repositoryId, headSha) && opts.fetch !== false) await repos.ensureCommit(repositoryId, headSha);
      return standing.ensureIndexed(repositoryId, headSha);
    },
  };
}

export type ImportStatus = "exists" | "missing" | "external";
export interface ImportNote { path: string; line: number; module: string; name?: string; status: ImportStatus; version?: string; resolvedPath?: string }
export interface ClassNote { name: string; path: string; line: number; bases: { name: string; path?: string; line?: number; abstractMembers: string[] }[]; implemented: string[]; missingAbstract: string[] }
export interface CallerNote { name: string; path: string; line: number; callers: GrepHit[]; tests: GrepHit[] }
export interface DefinitionNote { name: string; defs: SymbolDef[] }
export interface PackFile { path: string; language: ReviewLanguage | undefined; content: string; truncated: boolean; changedLines: number[] }

export interface ContextPack {
  commitSha: string;
  files: PackFile[];
  definitions: DefinitionNote[];
  classes: ClassNote[];
  callers: CallerNote[];
  imports: ImportNote[];
  related: SearchHit[];
  rules: { path: string; text: string }[];
  versions: Record<string, string>;
  stats: { identifiers: number; resolved: number; buildMs: number };
}

export const RULE_FILES = ["AGENTS.md", "CLAUDE.md", ".cursorrules", ".review/rules.md"];
const MAX_FILE_LINES = 1500;
const KEYWORDS = new Set(("self cls this super None True False null undefined true false nil return if else elif for while in is not and or def class import from as with try except "
  + "finally raise pass break continue lambda yield await async const let var function new typeof instanceof void delete throw catch switch case default export extends implements "
  + "interface type enum public private protected static final abstract package func go defer chan map struct range select nil end do then begin rescue ensure module require "
  + "elsif unless until when puts print len str int float bool dict list set tuple object string number any boolean Exception isinstance hasattr getattr setattr super "
  + "Optional List Dict Any Union Callable Sequence Mapping Iterable Promise Array Record Partial String Number Boolean Error Object Map Set Math JSON console err ctx error fmt").split(" "));

/** New-side line numbers of added lines, per file. */
export function addedLines(f: DiffFile): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = [];
  for (const h of f.hunks) {
    let n = h.newStart;
    for (const l of h.text.split("\n").slice(1)) {
      if (l.startsWith("+")) { out.push({ line: n, text: l.slice(1) }); n++; }
      else if (l.startsWith(" ")) n++;
    }
  }
  return out;
}

/** Identifiers the diff adds/touches, most specific first (CamelCase / called / attribute names), keywords and short names dropped. */
export function touchedIdentifiers(files: DiffFile[], cap = 60): string[] {
  const score = new Map<string, number>();
  for (const f of files) for (const { text } of addedLines(f)) {
    const code = text.replace(/(#|\/\/).*$/, "").replace(/(["'`])(?:\\.|(?!\1).)*\1/g, "");
    for (const m of code.matchAll(/(\.?)([A-Za-z_][A-Za-z0-9_]*)(\s*\()?/g)) {
      const name = m[2]!;
      if (name.length < 3 || KEYWORDS.has(name) || /^[A-Z0-9_]+$/.test(name) && name.length < 4) continue;
      const s = (/^[A-Z][a-z]/.test(name) ? 3 : 0) + (m[3] ? 2 : 0) + (m[1] ? 1 : 0) + (name.includes("_") ? 1 : 0) + 1;
      score.set(name, (score.get(name) ?? 0) + s);
    }
  }
  return [...score].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, cap).map(([n]) => n);
}

// ---------------- imports ----------------
interface RawImport { path: string; line: number; module: string; names: string[]; lang: ReviewLanguage }

export function parseAddedImports(files: DiffFile[]): RawImport[] {
  const out: RawImport[] = [];
  for (const f of files) {
    const lang = languageOf(f.path);
    if (!lang) continue;
    const lines = addedLines(f);
    for (let i = 0; i < lines.length; i++) {
      const { line, text } = lines[i]!;
      let m: RegExpExecArray | null;
      if (lang === "python") {
        if ((m = /^\s*from\s+([.\w]+)\s+import\s+(.+)$/.exec(text))) {
          let names = m[2]!;
          // Parenthesised multi-line import: collect following added lines until ')'.
          if (names.includes("(") && !names.includes(")")) for (let j = i + 1; j < lines.length && j < i + 40; j++) { names += " " + lines[j]!.text; if (lines[j]!.text.includes(")")) break; }
          out.push({ path: f.path, line, module: m[1]!, names: names.replace(/[()]/g, " ").split(",").map((x) => x.trim().split(/\s+as\s+/)[0]!.trim()).filter((x) => /^\w+$/.test(x)), lang });
        } else if ((m = /^\s*import\s+([\w.]+(?:\s*,\s*[\w.]+)*)/.exec(text))) for (const mod of m[1]!.split(",")) out.push({ path: f.path, line, module: mod.trim(), names: [], lang });
      } else if (lang === "typescript" || lang === "javascript") {
        if ((m = /^\s*import\s+(?:type\s+)?(.*?)\s+from\s+["']([^"']+)["']/.exec(text))) {
          const names = [...(m[1]!.match(/\{([^}]*)\}/)?.[1] ?? "").split(",").map((x) => x.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]!.trim()).filter(Boolean)];
          out.push({ path: f.path, line, module: m[2]!, names, lang });
        } else if ((m = /require\(\s*["']([^"']+)["']\s*\)/.exec(text))) out.push({ path: f.path, line, module: m[1]!, names: [], lang });
      } else if (lang === "go") {
        if ((m = /^\s*(?:import\s+)?(?:\w+\s+)?"([\w./-]+)"\s*$/.exec(text))) out.push({ path: f.path, line, module: m[1]!, names: [], lang });
      } else if (lang === "java") {
        if ((m = /^\s*import\s+(?:static\s+)?([\w.]+)\s*;/.exec(text))) { const parts = m[1]!.split("."); out.push({ path: f.path, line, module: parts.slice(0, -1).join("."), names: [parts.at(-1)!], lang }); }
      } else if (lang === "ruby") {
        if ((m = /^\s*require(?:_relative)?\s+["']([^"']+)["']/.exec(text))) out.push({ path: f.path, line, module: m[1]!, names: [], lang });
      }
    }
  }
  return out;
}

async function manifestVersion(ix: CodeIndex, lang: ReviewLanguage, pkg: string, paths: string[]): Promise<string | undefined> {
  const top = pkg.replace(/^@([^/]+\/[^/]+).*$/, "@$1").split(lang === "go" ? /\s/ : /[./]/)[0]!;
  const files: Record<ReviewLanguage, RegExp> = {
    python: /(^|\/)(requirements[^/]*\.txt|pyproject\.toml|setup\.cfg|uv\.lock|poetry\.lock)$/, typescript: /(^|\/)package\.json$/, javascript: /(^|\/)package\.json$/,
    go: /(^|\/)go\.mod$/, java: /(^|\/)(pom\.xml|build\.gradle(\.kts)?)$/, ruby: /(^|\/)Gemfile\.lock$/,
  };
  const name = lang === "go" ? pkg : top;
  for (const p of paths.filter((x) => files[lang].test(x)).sort((a, b) => a.length - b.length).slice(0, 6)) {
    const t = await ix.readFile(p);
    if (!t) continue;
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const m = lang === "python" ? new RegExp(`^\\s*"?${esc.replace(/[-_]/g, "[-_]")}(?:\\[[^\\]]*\\])?\\s*([=<>~!]=?\\s*[\\w.*]+)`, "im").exec(t)
      : lang === "go" ? new RegExp(`^\\s*(?:require\\s+)?(${esc}\\S*)\\s+(v[\\w.+-]+)`, "m").exec(t)
      : lang === "ruby" ? new RegExp(`^\\s{4}${esc} \\(([^)]+)\\)`, "m").exec(t)
      : lang === "java" ? new RegExp(`<artifactId>${esc}</artifactId>\\s*<version>([^<]+)</version>`, "m").exec(t)
      : new RegExp(`"${esc}"\\s*:\\s*"([^"]+)"`).exec(t);
    if (m) return (m[2] ?? m[1])!.replace(/\s+/g, "");
  }
  return undefined;
}

/** Names a module file defines or re-exports (top-level entities, module vars, imported names, __all__ / export lists). */
async function moduleExports(ix: CodeIndex, path: string): Promise<Set<string>> {
  const out = new Set<string>();
  const p = await ix.parse(path);
  for (const e of p?.entities ?? []) if (!e.parent) out.add(e.name);
  for (const e of p?.edges ?? []) if (e.kind === "import") out.add(e.dstName.split(".").pop()!);
  const t = (await ix.readFile(path)) ?? "";
  for (const m of t.matchAll(/^([A-Za-z_]\w*)\s*(?::[^=\n]*)?=/gm)) out.add(m[1]!);
  for (const m of t.matchAll(/^\s*export\s+(?:default\s+)?(?:async\s+)?(?:const|let|var|function\*?|class|interface|type|enum|abstract\s+class)\s+([A-Za-z_$][\w$]*)/gm)) out.add(m[1]!);
  for (const m of t.matchAll(/export\s*\{([^}]*)\}/g)) for (const n of m[1]!.split(",")) out.add(n.trim().split(/\s+as\s+/).pop()!.trim());
  for (const m of t.matchAll(/^\s*from\s+[.\w]+\s+import\s+\(?([^)\n]+)/gm)) for (const n of m[1]!.split(",")) out.add(n.trim().split(/\s+as\s+/).pop()!.trim());
  return out;
}

export async function resolveImports(ix: CodeIndex, raw: RawImport[]): Promise<ImportNote[]> {
  const paths = await ix.paths();
  const set = new Set(paths);
  const notes: ImportNote[] = [];
  const goMod = paths.find((p) => p === "go.mod");
  const goModule = goMod ? /^module\s+(\S+)/m.exec((await ix.readFile(goMod)) ?? "")?.[1] : undefined;
  for (const r of raw) {
    let candidates: string[] = [];
    if (r.lang === "python") {
      let mod = r.module;
      if (mod.startsWith(".")) {
        const up = mod.match(/^\.+/)![0].length;
        const base = r.path.split("/").slice(0, -up);
        mod = [...base, ...mod.slice(up).split(".").filter(Boolean)].join("/");
      } else mod = mod.replace(/\./g, "/");
      candidates = paths.filter((p) => p === `${mod}.py` || p === `${mod}/__init__.py` || p.endsWith(`/${mod}.py`) || p.endsWith(`/${mod}/__init__.py`));
    } else if (r.lang === "typescript" || r.lang === "javascript") {
      if (r.module.startsWith(".")) {
        const parts = [...r.path.split("/").slice(0, -1)];
        for (const seg of r.module.split("/")) { if (seg === "..") parts.pop(); else if (seg !== ".") parts.push(seg); }
        const b = parts.join("/").replace(/\.(js|mjs|cjs)$/, "");
        candidates = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", "/index.ts", "/index.tsx", "/index.js"].map((e) => b + e).filter((p) => set.has(p));
      } else if (r.module.startsWith("@/") || r.module.startsWith("~/")) {
        const b = r.module.slice(2);
        candidates = paths.filter((p) => /\.(tsx?|jsx?)$/.test(p) && (p.replace(/\.(tsx?|jsx?)$/, "").endsWith(b) || p.replace(/\/index\.(tsx?|jsx?)$/, "").endsWith(b)));
      }
    } else if (r.lang === "go") {
      if (goModule && r.module.startsWith(goModule + "/")) { const dir = r.module.slice(goModule.length + 1) + "/"; candidates = paths.filter((p) => p.startsWith(dir) && p.endsWith(".go") && !p.slice(dir.length).includes("/")); }
    } else if (r.lang === "java") {
      const f = `${r.module.replace(/\./g, "/")}/${r.names[0]}.java`;
      candidates = paths.filter((p) => p.endsWith(f));
      if (!candidates.length && paths.some((p) => p.includes(r.module.replace(/\./g, "/") + "/"))) { notes.push({ path: r.path, line: r.line, module: r.module, name: r.names[0]!, status: "missing" }); continue; }
    } else if (r.lang === "ruby") {
      candidates = paths.filter((p) => p.endsWith(`${r.module}.rb`));
    }
    const internalPrefix = r.lang === "python" && !r.module.startsWith(".") ? r.module.split(".")[0]! : undefined;
    const looksInternal = internalPrefix ? paths.some((p) => p.startsWith(`${internalPrefix}/`) || p.includes(`/${internalPrefix}/`)) : r.module.startsWith(".") || (goModule !== undefined && r.module.startsWith(goModule));
    if (!candidates.length) {
      if (looksInternal) notes.push({ path: r.path, line: r.line, module: r.module, status: "missing" });
      else { const version = await manifestVersion(ix, r.lang, r.module, paths); notes.push({ path: r.path, line: r.line, module: r.module, status: "external", ...(version ? { version } : {}) }); }
      continue;
    }
    if (!r.names.length || r.lang === "go" || r.lang === "ruby") { notes.push({ path: r.path, line: r.line, module: r.module, status: "exists", resolvedPath: candidates[0]! }); continue; }
    const exported = new Set<string>();
    for (const c of candidates.slice(0, 3)) for (const n of await moduleExports(ix, c)) exported.add(n);
    for (const name of r.names) {
      // A python package may expose a submodule of the same name.
      const sub = r.lang === "python" && candidates.some((c) => set.has(c.replace(/(__init__)?\.py$/, "").replace(/\/$/, "") + `/${name}.py`));
      notes.push({ path: r.path, line: r.line, module: r.module, name, status: exported.has(name) || sub || name === "*" ? "exists" : "missing", resolvedPath: candidates[0]! });
    }
  }
  return notes;
}

// ---------------- versions + rules ----------------
export async function detectVersions(ix: CodeIndex): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const read = async (p: string) => (await ix.readFile(p))?.trim();
  const pv = await read(".python-version");
  if (pv) out.python = pv.split("\n")[0]!;
  const py = await read("pyproject.toml");
  const rp = py && /requires-python\s*=\s*["']([^"']+)["']/.exec(py)?.[1];
  if (rp) out["requires-python"] = rp;
  const pkg = await read("package.json");
  if (pkg) { try { const j = JSON.parse(pkg) as { engines?: { node?: string }; devDependencies?: Record<string, string>; dependencies?: Record<string, string> }; if (j.engines?.node) out.node = j.engines.node; const ts = j.devDependencies?.typescript ?? j.dependencies?.typescript; if (ts) out.typescript = ts; } catch { /* malformed package.json is repo content, not our error */ } }
  const nv = await read(".nvmrc");
  if (nv) out.node ??= nv;
  const gm = await read("go.mod");
  const gv = gm && /^go\s+(\S+)/m.exec(gm)?.[1];
  if (gv) out.go = gv;
  const rv = await read(".ruby-version");
  if (rv) out.ruby = rv;
  const pom = await read("pom.xml");
  const jv = pom && /<(?:maven\.compiler\.release|maven\.compiler\.source|java\.version|release)>([^<]+)</.exec(pom)?.[1];
  if (jv) out.java = jv;
  return out;
}

/** Repo rule files at the root plus directory-scoped ones above changed files (nearest wins later in the list). */
export async function readRuleFiles(ix: CodeIndex, changed: string[], maxChars = 8000): Promise<{ path: string; text: string }[]> {
  const dirs = new Set<string>([""]);
  for (const p of changed) { const parts = p.split("/").slice(0, -1); for (let i = 1; i <= parts.length; i++) dirs.add(parts.slice(0, i).join("/") + "/"); }
  const out: { path: string; text: string }[] = [];
  for (const d of [...dirs].sort((a, b) => a.length - b.length)) for (const f of RULE_FILES) {
    const t = await ix.readFile(d + f);
    if (t?.trim()) out.push({ path: d + f, text: t.slice(0, maxChars) });
  }
  return out;
}

// ---------------- pack ----------------
export interface PackOptions { tokenBudget?: number; maxIdentifiers?: number; maxCallers?: number; log?: (phase: string, ms: number) => void }

const lineSet = (f: DiffFile) => addedLines(f).map((l) => l.line);
const overlaps = (s: number, e: number, lines: number[]) => lines.some((l) => l >= s && l <= e);

function truncateAround(text: string, changed: number[]): { content: string; truncated: boolean } {
  const lines = text.split("\n");
  if (lines.length <= MAX_FILE_LINES) return { content: text, truncated: false };
  const keep = new Set<number>();
  for (const c of changed) for (let i = Math.max(1, c - 60); i <= Math.min(lines.length, c + 60); i++) keep.add(i);
  for (let i = 1; i <= 40; i++) keep.add(i);
  const out: string[] = [];
  let gap = false;
  lines.forEach((l, i) => { if (keep.has(i + 1)) { out.push(l); gap = false; } else if (!gap) { out.push(`... [lines omitted] ...`); gap = true; } });
  return { content: out.join("\n"), truncated: true };
}

const GLOBS: Record<ReviewLanguage, string[]> = {
  python: ["*.py", "*.pyi"], typescript: ["*.ts", "*.tsx", "*.js", "*.mjs"], javascript: ["*.js", "*.jsx", "*.mjs", "*.ts"], go: ["*.go"], java: ["*.java"], ruby: ["*.rb", "*.rake"],
};
/** Pathspec globs for the languages of the changed files (definitions/references only searched there). */
export const globsFor = (paths: string[]) => [...new Set(paths.flatMap((p) => { const l = languageOf(p); return l ? GLOBS[l] : []; }))];

/** Build the context pack (GREPTILE-GAP §3.2, items a-f) for the changed files at the index commit. Independent sections run concurrently. */
export async function buildContextPack(ix: CodeIndex, files: DiffFile[], opts: PackOptions = {}): Promise<ContextPack> {
  const t0 = Date.now();
  const timed = async <T>(phase: string, p: Promise<T>): Promise<T> => { const s0 = Date.now(); const v = await p; opts.log?.(phase, Date.now() - s0); return v; };
  const changed = files.map((f) => f.path);
  const code = files.filter((f) => languageOf(f.path));
  const globs = globsFor(changed);
  const g = globs.length ? { globs } : {};
  const parsed = new Map(await Promise.all(code.map(async (f) => [f.path, await ix.parse(f.path)] as const)));
  const localNames = new Set([...parsed.values()].flatMap((p) => p?.entities.map((e) => e.name) ?? []));
  const idents = touchedIdentifiers(code, opts.maxIdentifiers ?? 60);
  const external = idents.filter((n) => !localNames.has(n));

  // (a) full post-change text
  const filesP = timed("files", (async () => {
    const out: PackFile[] = [];
    for (const f of code) {
      const t = await ix.readFile(f.path);
      if (t === undefined) continue;
      const lines = lineSet(f);
      out.push({ path: f.path, language: languageOf(f.path), ...truncateAround(t, lines), changedLines: lines });
    }
    return out;
  })());
  // (b) definitions of touched identifiers
  const defsP = timed("definitions", ix.definitionsMany(external, { limit: 2, preferPaths: changed, ...g })
    .then((defs) => [...defs].filter(([, d]) => d.length).map(([name, d]) => ({ name, defs: d }))));
  // (c) changed classes -> bases + abstract members (two levels up)
  // Classes resolve concurrently (bounded): sequential resolution took 48 s on a 28-class Sentry PR.
  const classesP = timed("classes", (async () => {
    const limit = createLimiter(8);
    const work: Promise<ClassNote>[] = [];
    for (const f of code) for (const e of parsed.get(f.path)?.entities ?? []) {
      const ownBases = e.bases;
      if (e.kind !== "class" || !ownBases?.length || !overlaps(e.startLine, e.endLine, lineSet(f))) continue;
      work.push(limit(async () => {
      const implemented = (parsed.get(f.path)?.entities ?? []).filter((m) => m.kind === "method" && m.startLine > e.startLine && m.endLine <= e.endLine).map((m) => m.name);
      const bases: ClassNote["bases"] = [];
      const abstract = new Set<string>();
      let frontier = ownBases;
      for (let depth = 0; depth < 2 && frontier.length; depth++) {
        const found = await ix.definitionsMany(frontier, { limit: 1, preferPaths: changed, ...g });
        const next: string[] = [];
        for (const [name, [d]] of found) {
          if (!d) continue;
          const abs = (await ix.members(d)).filter((m) => m.abstract).map((m) => m.name);
          abs.forEach((x) => abstract.add(x));
          bases.push({ name, path: d.path, line: d.startLine, abstractMembers: abs });
          next.push(...(d.bases ?? []).filter((b) => !["ABC", "object", "Generic", "Protocol"].includes(b)));
        }
        frontier = next;
      }
      return { name: e.name, path: f.path, line: e.startLine, bases, implemented, missingAbstract: [...abstract].filter((x) => !implemented.includes(x)).sort() };
      }));
    }
    return Promise.all(work);
  })());
  // (d) callers + tests for changed functions
  const fns: { name: string; path: string; line: number }[] = [];
  for (const f of code) for (const e of parsed.get(f.path)?.entities ?? []) {
    if ((e.kind === "function" || e.kind === "method") && overlaps(e.startLine, e.endLine, lineSet(f)) && e.name.length > 3 && !e.name.startsWith("__")) fns.push({ name: e.name, path: f.path, line: e.startLine });
  }
  const fnTop = fns.slice(0, 25);
  const callersP = timed("callers", ix.referencesMany(fnTop.map((f) => f.name), { limit: 30, ...g }).then((refs) => fnTop.map((f) => {
    const all = refs.get(f.name) ?? [];
    return { ...f, callers: all.filter((h) => !isTestPath(h.path)).slice(0, opts.maxCallers ?? 10), tests: all.filter((h) => isTestPath(h.path)).slice(0, 5) };
  }).filter((c) => c.callers.length || c.tests.length)));
  // (e) imports
  const importsP = timed("imports", resolveImports(ix, parseAddedImports(code)));
  const rulesP = readRuleFiles(ix, changed);
  const versionsP = detectVersions(ix);
  const [packFiles, definitions, classes, callers, imports, rules, versions] = await Promise.all([filesP, defsP, classesP, callersP, importsP, rulesP, versionsP]);
  // (f) hybrid retrieval: same-named symbols + siblings of changed classes (needs class bases)
  const seeds = [...new Set([...classes.flatMap((c) => c.bases.map((b) => b.name)), ...fnTop.slice(0, 5).map((f) => f.name)])];
  const query = [...seeds, ...idents.slice(0, 6)].join(" ");
  const related = query ? (await timed("related", ix.search(query, { k: 8, seeds, ...g }))).filter((h) => !changed.includes(h.path)) : [];
  return { commitSha: ix.commitSha, files: packFiles, definitions, classes, callers, imports, related, rules, versions,
    stats: { identifiers: external.length, resolved: definitions.length, buildMs: Date.now() - t0 } };
}

const tok = (s: string) => Math.ceil(s.length / 4);

/**
 * Render the pack for one agent under a token budget. Facts first (imports, abstract gaps, versions), then definitions,
 * callers, focus files, related code, other files. Sections are cut whole-item when the budget runs out.
 */
export function renderPack(pack: ContextPack, opts: { focus?: string[]; tokenBudget?: number; includeFiles?: boolean } = {}): string {
  const budget = opts.tokenBudget ?? 60_000;
  const focus = new Set(opts.focus ?? pack.files.map((f) => f.path));
  const inFocus = (p: string) => focus.has(p);
  const out: string[] = [];
  let used = 0;
  const push = (s: string) => { const t = tok(s); if (used + t > budget) return false; out.push(s); used += t; return true; };
  const imp = pack.imports.filter((i) => inFocus(i.path));
  if (imp.length) push("## Imports added by the change\n" + imp.map((i) => `- ${i.path}:${i.line} ${i.module}${i.name ? `.${i.name}` : ""}: ${i.status.toUpperCase()}${i.version ? ` (${i.version})` : ""}${i.resolvedPath ? ` -> ${i.resolvedPath}` : ""}`).join("\n"));
  const cls = pack.classes.filter((c) => inFocus(c.path));
  if (cls.length) push("## Changed classes and their bases\n" + cls.map((c) => `- ${c.path}:${c.line} class ${c.name}(${c.bases.map((b) => b.name).join(", ")}); implements [${c.implemented.join(", ")}]`
    + c.bases.map((b) => `\n  - base ${b.name} at ${b.path}:${b.line}; abstract members: [${b.abstractMembers.join(", ")}]`).join("")
    + (c.missingAbstract.length ? `\n  - NOT IMPLEMENTED abstract members: [${c.missingAbstract.join(", ")}]` : "")).join("\n"));
  if (Object.keys(pack.versions).length) push("## Toolchain versions\n" + Object.entries(pack.versions).map(([k, v]) => `- ${k}: ${v}`).join("\n"));
  if (pack.rules.length) push("## Repository rules\n" + pack.rules.map((r) => `### ${r.path}\n${r.text}`).join("\n"));
  const files = opts.includeFiles === false ? [] : [...pack.files].sort((a, b) => Number(inFocus(b.path)) - Number(inFocus(a.path)));
  const fileBudget = Math.floor((budget - used) * 0.55);
  let fileUsed = 0;
  for (const f of files) {
    const s = `## File ${f.path} (full post-change text${f.truncated ? ", truncated around changes" : ""})\n${f.content.split("\n").map((l, i) => `${String(i + 1).padStart(5)}  ${l}`).join("\n")}`;
    if (fileUsed + tok(s) > fileBudget && fileUsed > 0) { push(`## File ${f.path}: omitted (budget); use read_file`); continue; }
    if (push(s)) fileUsed += tok(s);
  }
  for (const d of pack.definitions) if (!push(`## Definition of ${d.name}\n` + d.defs.map((x) => `### ${x.path}:${x.startLine} (${x.kind})\n${x.text}`).join("\n"))) break;
  const cal = pack.callers.filter((c) => inFocus(c.path));
  if (cal.length) push("## Callers and tests of changed functions\n" + cal.map((c) => `- ${c.name} (${c.path}:${c.line})\n` + [...c.callers, ...c.tests].map((h) => `  - ${h.path}:${h.line}: ${h.text.trim()}`).join("\n")).join("\n"));
  for (const r of pack.related) if (!push(`## Related code ${r.path}:${r.startLine} (via ${r.via.join("+")})\n${r.text}`)) break;
  return out.join("\n\n");
}

/** Does the pack contain a definition (or class note) for the symbol, or the line range in a file? Used by the coverage gate. */
export function packCovers(pack: ContextPack, need: { symbol?: string; path?: string; line?: number }): boolean {
  if (need.symbol) {
    const s = need.symbol;
    if (pack.definitions.some((d) => d.name === s)) return true;
    if (pack.classes.some((c) => c.name === s || c.bases.some((b) => b.name === s))) return true;
    if (pack.imports.some((i) => i.name === s || i.module.endsWith(s))) return true;
    if (pack.files.some((f) => new RegExp(`(def|class|func|function)\\s+${s}\\b`).test(f.content))) return true;
    return false;
  }
  if (need.path) return pack.files.some((f) => f.path === need.path && (need.line === undefined || f.content.split("\n").length >= need.line))
    || pack.definitions.some((d) => d.defs.some((x) => x.path === need.path && (need.line === undefined || (x.startLine <= need.line && x.endLine >= need.line))));
  return false;
}

export const globMatch = (p: string, g: string) => matchesGlob(p, g);
