import type { SandboxLimits } from "@review/core";
import type { SandboxDriver } from "./sandbox.ts";

/**
 * Execution validation (GREPTILE-GAP §5): E0 compile/type-check, E1 import/instantiate smoke, E2 referencing tests, E3 hypothesis tests.
 * Commands run through a SandboxDriver (gVisor/Firecracker; never runc). Output is parsed into diff-anchored findings only.
 */
export type ExecLanguage = "python" | "typescript" | "javascript" | "go" | "java" | "ruby";
export type ExecLevel = "E0" | "E1" | "E2" | "E3";

export interface ExecCommand { level: ExecLevel; language: ExecLanguage; argv: string[]; label: string; /** inline files (scripts/tests) written before running */ files?: Record<string, string> }
export interface CheckResult { exitCode: number; stdout: string; stderr: string; timedOut: boolean }
/** Port the orchestrator uses; sandboxExecutor binds it to a driver + checked-out workspace. */
export interface ExecutionPort { run(cmd: ExecCommand): Promise<CheckResult> }

export interface ExecFinding {
  category: "bug"; severity: "high" | "medium"; title: string; body: string;
  location: { path: string; startLine: number; endLine: number };
  confidence: number;
  evidence: { command: string; exitCode: number; stderrExcerpt: string };
  level: ExecLevel;
}

export const EXEC_CONFIDENCE = 0.9;
const LANG: Record<string, ExecLanguage> = { py: "python", ts: "typescript", tsx: "typescript", js: "javascript", mjs: "javascript", go: "go", java: "java", rb: "ruby" };
export const execLanguage = (p: string): ExecLanguage | undefined => LANG[p.slice(p.lastIndexOf(".") + 1).toLowerCase()];
const dirOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : ".");
const isTest = (p: string) => /(^|\/)(tests?|spec|__tests__)\/|(_test|\.test|\.spec|_spec)\.[a-z]+$|(^|\/)test_[^/]*$/.test(p);

/** Python module name for a source path (src/ layout aware). */
export function pyModule(path: string): string {
  return path.replace(/^src\//, "").replace(/\.py$/, "").replace(/\/__init__$/, "").replace(/\//g, ".");
}

/** E0: compile/type-check commands for the changed files. */
export function e0Commands(paths: string[]): ExecCommand[] {
  const by = new Map<ExecLanguage, string[]>();
  for (const p of paths) { const l = execLanguage(p); if (l) by.set(l, [...(by.get(l) ?? []), p]); }
  const out: ExecCommand[] = [];
  for (const [language, ps] of by) {
    if (language === "python") {
      out.push({ level: "E0", language, label: "py_compile", argv: ["python", "-m", "py_compile", ...ps] });
      out.push({ level: "E0", language, label: "mypy", argv: ["mypy", "--follow-imports=silent", "--ignore-missing-imports", "--no-error-summary", "--show-column-numbers", ...ps.filter((p) => !isTest(p))] });
    } else if (language === "typescript" || language === "javascript") {
      out.push({ level: "E0", language, label: "tsc", argv: ["npx", "--no-install", "tsc", "--noEmit", "-p", "."] });
    } else if (language === "go") {
      const pkgs = [...new Set(ps.map((p) => `./${dirOf(p)}`))];
      out.push({ level: "E0", language, label: "go build", argv: ["go", "build", ...pkgs] });
      out.push({ level: "E0", language, label: "go vet", argv: ["go", "vet", ...pkgs] });
    } else if (language === "java") {
      out.push({ level: "E0", language, label: "javac", argv: ["javac", "-d", "/tmp/javac-out", "-proc:none", ...ps] });
    } else if (language === "ruby") {
      for (const p of ps) out.push({ level: "E0", language, label: `ruby -c ${p}`, argv: ["ruby", "-c", p] });
    }
  }
  return out;
}

/** E1: import every changed python module and instantiate changed concrete classes whose constructor takes no required args. */
export function e1Commands(paths: string[], classes: { path: string; name: string }[] = []): ExecCommand[] {
  const py = paths.filter((p) => execLanguage(p) === "python" && !isTest(p));
  if (!py.length) return [];
  const script = [
    "import importlib, inspect, sys, traceback",
    `mods = ${JSON.stringify(py.map(pyModule))}`,
    `classes = ${JSON.stringify(classes.filter((c) => py.includes(c.path)).map((c) => [pyModule(c.path), c.name]))}`,
    "rc = 0",
    "for m in mods:",
    "    try: importlib.import_module(m)",
    "    except ModuleNotFoundError as e:",
    "        print(f'SKIP {m}: {e}', file=sys.stderr)",
    "    except Exception:",
    "        traceback.print_exc(); rc = 1",
    "for m, c in classes:",
    "    try:",
    "        cls = getattr(importlib.import_module(m), c)",
    "        if inspect.isabstract(cls):",
    "            missing = sorted(getattr(cls, '__abstractmethods__', []))",
    "            src = inspect.getsourcefile(cls); line = inspect.getsourcelines(cls)[1]",
    "            print(f'File \"{src}\", line {line}\\nTypeError: Can\\'t instantiate abstract class {c} without an implementation for abstract methods {missing}', file=sys.stderr); rc = 1",
    "    except ModuleNotFoundError: pass",
    "    except Exception: traceback.print_exc(); rc = 1",
    "sys.exit(rc)",
  ].join("\n");
  return [{ level: "E1", language: "python", label: "import smoke", argv: ["python", "/workspace/.review/e1_smoke.py"], files: { ".review/e1_smoke.py": script } }];
}

/** E2: run the existing tests that reference changed symbols. */
export function e2Commands(testPaths: string[]): ExecCommand[] {
  const by = new Map<ExecLanguage, string[]>();
  for (const p of [...new Set(testPaths)].slice(0, 20)) { const l = execLanguage(p); if (l) by.set(l, [...(by.get(l) ?? []), p]); }
  const out: ExecCommand[] = [];
  for (const [language, ps] of by) {
    if (language === "python") out.push({ level: "E2", language, label: "pytest", argv: ["python", "-m", "pytest", "-x", "-q", "-p", "no:cacheprovider", ...ps] });
    else if (language === "typescript" || language === "javascript") out.push({ level: "E2", language, label: "vitest", argv: ["npx", "--no-install", "vitest", "run", ...ps] });
    else if (language === "go") out.push({ level: "E2", language, label: "go test", argv: ["go", "test", ...[...new Set(ps.map((p) => `./${dirOf(p)}`))]] });
    else if (language === "ruby") out.push({ level: "E2", language, label: "ruby tests", argv: ["ruby", "-Itest", "-Ispec", ...ps] });
    else if (language === "java") out.push({ level: "E2", language, label: "maven tests", argv: ["mvn", "-q", "-o", "test", `-Dtest=${ps.map((p) => p.split("/").pop()!.replace(/\.java$/, "")).join(",")}`] });
  }
  return out;
}

/** E3: a focused test a hunter wrote for its hypothesis. The finding is confirmed only if the test FAILS on head. */
export interface HypothesisTest { path: string; content: string; language: ExecLanguage; target: { path: string; startLine: number; endLine: number }; title: string }
export function e3Command(t: HypothesisTest): ExecCommand {
  const argv = t.language === "python" ? ["python", "-m", "pytest", "-x", "-q", "-p", "no:cacheprovider", t.path]
    : t.language === "go" ? ["go", "test", "-run", ".", `./${dirOf(t.path)}`]
    : t.language === "ruby" ? ["ruby", t.path]
    : t.language === "java" ? ["java", t.path]
    : ["npx", "--no-install", "vitest", "run", t.path];
  return { level: "E3", language: t.language, label: `hypothesis test ${t.path}`, argv, files: { [t.path]: t.content } };
}

// ---------------- output parsing ----------------
export interface Anchor { path: string; line: number; message: string }

/** Extract file:line diagnostics from compiler / type-checker / traceback output. Paths are normalised to repo-relative. */
export function parseDiagnostics(out: string, label: string): Anchor[] {
  const rel = (p: string) => p.replace(/^\/workspace\//, "").replace(/^\.\//, "");
  const anchors: Anchor[] = [];
  const lines = out.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    let m: RegExpExecArray | null;
    if ((m = /^\s*File "([^"]+)", line (\d+)/.exec(l))) {
      // Python traceback frame / py_compile: message is the last non-indented line after the frames.
      const msg = lines.slice(i + 1).find((x) => /^[A-Za-z_.]+(Error|Exception|Warning)\b/.test(x)) ?? l;
      anchors.push({ path: rel(m[1]!), line: Number(m[2]), message: msg.trim() });
    } else if ((m = /^([^\s:()]+\.(?:py|go|rb|java|tsx?|jsx?|mjs)):(\d+):(?:\d+:)?\s*(?:error:|warning:)?\s*(.*)$/.exec(l))) {
      if (label === "mypy" && !/error:/.test(l)) continue;
      anchors.push({ path: rel(m[1]!), line: Number(m[2]), message: m[3]!.trim() });
    } else if ((m = /^([^\s:()]+\.tsx?)\((\d+),\d+\):\s*error\s*(.*)$/.exec(l))) {
      anchors.push({ path: rel(m[1]!), line: Number(m[2]), message: m[3]!.trim() });
    }
  }
  return anchors;
}

const MYPY_NOISE = /Library stubs not installed|Cannot find implementation or library stub|Skipping analyzing|missing library stubs|is not a valid Python package name|Name .* already defined \(possibly by an import\)|Duplicate module named/;

/**
 * Turn an execution result into findings. Rules (GREPTILE-GAP §5.2): only anchors on a changed file within +/-3 lines of an
 * added line become findings ("never a comment without a diff anchor"); confidence >= 0.9; evidence carries the command.
 */
export function toFindings(cmd: ExecCommand, r: CheckResult, added: Map<string, number[]>): ExecFinding[] {
  if (r.timedOut) return [];
  if (r.exitCode === 0 && cmd.level !== "E3") return [];
  const out = `${r.stderr}\n${r.stdout}`;
  const command = cmd.argv.join(" ");
  const excerpt = (s: string) => (s.length > 1500 ? s.slice(0, 1500) + "\n[truncated]" : s);
  const near = (a: Anchor) => (added.get(a.path) ?? []).some((l) => Math.abs(l - a.line) <= 3);
  const seen = new Set<string>();
  const findings: ExecFinding[] = [];
  // Tools may print absolute paths of any mount point; map them onto the changed repo-relative path by suffix.
  const toRepo = (a: Anchor): Anchor => (added.has(a.path) ? a : { ...a, path: [...added.keys()].find((p) => a.path.endsWith(`/${p}`)) ?? a.path });
  for (const a of parseDiagnostics(out, cmd.label).map(toRepo)) {
    if (!near(a) || MYPY_NOISE.test(a.message) || /ModuleNotFoundError: No module named/.test(a.message) && cmd.level === "E1") continue;
    const k = `${a.path}:${a.line}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const ctx = out.split("\n").filter((x) => x.includes(a.path) || x === a.message || x.includes(a.message)).slice(0, 12).join("\n");
    findings.push({
      category: "bug", severity: cmd.level === "E0" || cmd.level === "E1" ? "high" : "medium", level: cmd.level,
      title: `${cmd.label} fails: ${a.message.slice(0, 150)}`.slice(0, 200),
      body: `\`${command}\` exited with ${r.exitCode} at this line (${cmd.level} execution check): ${a.message}`,
      location: { path: a.path, startLine: a.line, endLine: a.line },
      confidence: EXEC_CONFIDENCE, evidence: { command, exitCode: r.exitCode, stderrExcerpt: excerpt(ctx || out) },
    });
  }
  return findings;
}

/** E3 verdict: a hypothesis test that fails on head confirms the finding at the hypothesis target (always a diff anchor). */
export function e3Finding(t: HypothesisTest, cmd: ExecCommand, r: CheckResult, added: Map<string, number[]>): ExecFinding | undefined {
  if (r.timedOut || r.exitCode === 0) return undefined;
  if (/SyntaxError|ImportError while importing test module|collected 0 items|no tests ran/.test(r.stdout + r.stderr)) return undefined;
  const lines = added.get(t.target.path) ?? [];
  if (!lines.some((l) => l >= t.target.startLine - 3 && l <= t.target.endLine + 3)) return undefined;
  const command = cmd.argv.join(" ");
  return { category: "bug", severity: "medium", level: "E3", title: t.title.slice(0, 200), body: `Hypothesis test \`${t.path}\` fails on the PR head.`,
    location: t.target, confidence: EXEC_CONFIDENCE, evidence: { command, exitCode: r.exitCode, stderrExcerpt: (r.stdout + "\n" + r.stderr).slice(-1500) } };
}

// ---------------- sandbox binding ----------------
export const DEFAULT_IMAGES: Record<ExecLanguage, string> = {
  python: "python:3.13-slim", typescript: "node:24-slim", javascript: "node:24-slim", go: "golang:1.24", java: "eclipse-temurin:21-jdk", ruby: "ruby:3.4-slim",
};

/** Bind the port to a sandbox driver and a host workspace (a checkout of the PR head under SANDBOX_WORKSPACE_ROOT). No network. */
export function sandboxExecutor(driver: SandboxDriver, workspaceDir: string, opts: { images?: Partial<Record<ExecLanguage, string>>; limits?: Partial<SandboxLimits> } = {}): ExecutionPort {
  return {
    async run(cmd) {
      const r = await driver.run({ image: opts.images?.[cmd.language] ?? DEFAULT_IMAGES[cmd.language], command: cmd.argv, workspaceDir, ...(cmd.files ? { files: cmd.files } : {}),
        limits: { timeoutSec: cmd.level === "E2" || cmd.level === "E3" ? 600 : 180, memoryMb: 2048, network: "none", ...opts.limits } });
      return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr, timedOut: r.timedOut };
    },
  };
}

export interface ValidationInput { added: Map<string, number[]>; changedPaths: string[]; classes?: { path: string; name: string }[]; testPaths?: string[]; hypothesisTests?: HypothesisTest[]; levels?: ExecLevel[] }
export interface ValidationReport { findings: ExecFinding[]; runs: { label: string; level: ExecLevel; exitCode: number; timedOut: boolean; error?: string }[] }

/** Run E0 -> E1 -> E2 -> E3 (cheapest first). A failing/unavailable command is recorded, never fatal to the review. */
export async function validateExecution(port: ExecutionPort, input: ValidationInput): Promise<ValidationReport> {
  const levels = new Set(input.levels ?? ["E0", "E1", "E2", "E3"]);
  const cmds: ExecCommand[] = [
    ...(levels.has("E0") ? e0Commands(input.changedPaths) : []),
    ...(levels.has("E1") ? e1Commands(input.changedPaths, input.classes) : []),
    ...(levels.has("E2") ? e2Commands(input.testPaths ?? []) : []),
  ];
  const report: ValidationReport = { findings: [], runs: [] };
  for (const c of cmds) {
    try {
      const r = await port.run(c);
      report.runs.push({ label: c.label, level: c.level, exitCode: r.exitCode, timedOut: r.timedOut });
      // exit 127 / "not found": tool absent from the image, not a code defect.
      if (r.exitCode === 127 || /executable file not found|command not found|No module named (mypy|pytest)\b/.test(r.stderr)) continue;
      report.findings.push(...toFindings(c, r, input.added));
    } catch (e) { report.runs.push({ label: c.label, level: c.level, exitCode: -1, timedOut: false, error: (e as Error).message }); }
  }
  if (levels.has("E3")) for (const t of input.hypothesisTests ?? []) {
    const c = e3Command(t);
    try {
      const r = await port.run(c);
      report.runs.push({ label: c.label, level: "E3", exitCode: r.exitCode, timedOut: r.timedOut });
      const f = e3Finding(t, c, r, input.added);
      if (f) report.findings.push(f);
    } catch (e) { report.runs.push({ label: c.label, level: "E3", exitCode: -1, timedOut: false, error: (e as Error).message }); }
  }
  return report;
}
