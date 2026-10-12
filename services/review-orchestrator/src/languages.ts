/** Review languages with dedicated prompt addenda, compile checks and SCIP indexers (GREPTILE-GAP §8). */
export type ReviewLanguage = "python" | "typescript" | "javascript" | "go" | "java" | "ruby";

const EXT: Record<string, ReviewLanguage> = {
  py: "python", pyi: "python", ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript", go: "go", java: "java", rb: "ruby", rake: "ruby",
};
export const languageOf = (path: string): ReviewLanguage | undefined => EXT[path.slice(path.lastIndexOf(".") + 1).toLowerCase()];

/** SCIP indexer per language (used when the binary is installed; else tree-sitter tags + import-path resolution). */
export const SCIP_INDEXER: Record<ReviewLanguage, string> = {
  python: "scip-python", typescript: "scip-typescript", javascript: "scip-typescript", go: "scip-go", java: "scip-java", ruby: "scip-ruby",
};

/** Top bug idioms per language, injected only for files of that language. */
export const PROMPT_ADDENDA: Record<ReviewLanguage, string> = {
  python: [
    "Python checklist:",
    "- Truthiness of numbers/collections: `if x:` skips 0, 0.0, '' and []; use `is not None` when zero is valid.",
    "- Mutable defaults (def f(x=[]), dataclass field = datetime.now() / list) are evaluated once and shared.",
    "- Imports of names that do not exist in the target module (ImportError at import time); check the definition shown.",
    "- Subclasses of ABCs must implement every @abstractmethod or instantiation raises TypeError.",
    "- dict[key] / .get() returning None then dereferenced; Optional values used without a check.",
    "- Stdlib APIs are version-dependent (e.g. queue.ShutDown is 3.13+): check the toolchain version before claiming an API is missing.",
    "- Variables reassigned in a branch but the stale value used afterwards; exceptions swallowed by broad except.",
  ].join("\n"),
  typescript: [
    "TypeScript checklist:",
    "- async callbacks inside forEach/map are not awaited; promises dropped without await/catch.",
    "- SQL/ORM raw queries built by string concatenation (injection); Prisma where clauses that widen with OR.",
    "- Secret/token comparison must be timing-safe; case-insensitive comparisons of emails/ids.",
    "- Optional chaining missing on values typed as possibly undefined; non-null assertions hiding bugs.",
    "- Deleting or updating with a filter that can match more rows than intended.",
  ].join("\n"),
  javascript: "JavaScript checklist:\n- Unawaited promises, == vs ===, undefined property access, mutation of shared objects, string concatenation into queries/HTML.",
  go: [
    "Go checklist:",
    "- Undefined identifiers/constants (compile error); unused imports.",
    "- Data races: maps or struct fields written from goroutines without a mutex; loop variable capture.",
    "- Errors ignored or shadowed (err := inside a block); defer in loops; nil map writes; nil pointer on error paths.",
    "- Cache expiry / TTL arithmetic in time.Duration units; wrong metric type or method (Inc vs Add, Observe).",
  ].join("\n"),
  java: [
    "Java checklist:",
    "- Calls with the wrong arity/argument (does the overload exist with these parameters?); wrong receiver causing recursion.",
    "- Null checks on the wrong variable; Optional.get() without isPresent; equals vs ==.",
    "- Returning the wrong provider/instance from a factory; permission checks that test the wrong right.",
    "- Resources not closed (try-with-resources); exceptions swallowed.",
  ].join("\n"),
  ruby: [
    "Ruby checklist:",
    "- SSRF/command injection via open(url), Kernel#open, backticks with user input.",
    "- String mutation with << on frozen or shared strings; memoized ivars (@x ||=) not thread-safe in class-level state.",
    "- nil receivers (NoMethodError); safe navigation (&.) missing; DB writes inside predicate methods (?).",
    "- Rails callbacks (before_validation/after_save) ordering; N+1 queries.",
  ].join("\n"),
};

/** Version-awareness note for prompts: the toolchain versions declared by the repo. */
export function versionNote(versions: Record<string, string>): string {
  const e = Object.entries(versions);
  return e.length ? `Repository toolchain: ${e.map(([k, v]) => `${k} ${v}`).join(", ")}. Judge API availability against these versions.` : "";
}

export function addendaFor(paths: string[]): string {
  const langs = [...new Set(paths.map(languageOf).filter((l): l is ReviewLanguage => !!l))];
  return langs.map((l) => PROMPT_ADDENDA[l]).join("\n\n");
}
