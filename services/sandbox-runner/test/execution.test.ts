import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { e0Commands, e1Commands, e2Commands, e3Command, parseDiagnostics, pyModule, toFindings, validateExecution, type ExecutionPort } from "../src/index.ts";

const exec = promisify(execFile);

test("command planning per language and level", () => {
  expect(e0Commands(["src/a.py", "pkg/x/b.go", "lib/c.rb", "web/d.ts", "README.md"]).map((c) => c.label)).toEqual(["py_compile", "mypy", "go build", "go vet", "ruby -c lib/c.rb", "tsc"]);
  expect(pyModule("src/sentry/a/__init__.py")).toBe("sentry.a");
  expect(e1Commands(["tests/test_a.py"])).toEqual([]);
  expect(e2Commands(["tests/test_a.py", "x_test.go"]).map((c) => c.label)).toEqual(["pytest", "go test"]);
  expect(e3Command({ path: "tests/test_h.py", content: "", language: "python", target: { path: "a.py", startLine: 1, endLine: 1 }, title: "t" }).argv.at(-1)).toBe("tests/test_h.py");
});

test("diagnostics: traceback, compiler and tsc formats; only diff-anchored anchors become findings", () => {
  const tb = 'Traceback (most recent call last):\n  File "/workspace/src/a.py", line 3, in <module>\n    from b import X\nImportError: cannot import name \'X\' from \'b\'\n';
  expect(parseDiagnostics(tb, "import smoke")).toEqual([{ path: "src/a.py", line: 3, message: "ImportError: cannot import name 'X' from 'b'" }]);
  expect(parseDiagnostics("pkg/x/b.go:10:2: undefined: Foo", "go build")).toEqual([{ path: "pkg/x/b.go", line: 10, message: "undefined: Foo" }]);
  expect(parseDiagnostics("web/d.ts(4,7): error TS2304: Cannot find name 'q'.", "tsc")[0]).toMatchObject({ path: "web/d.ts", line: 4 });
  const cmd = { level: "E0" as const, language: "go" as const, label: "go build", argv: ["go", "build", "./pkg/x"] };
  const r = { exitCode: 1, stdout: "", stderr: "pkg/x/b.go:10:2: undefined: Foo\npkg/x/b.go:90:2: undefined: Bar", timedOut: false };
  const f = toFindings(cmd, r, new Map([["pkg/x/b.go", [9]]]));
  expect(f).toHaveLength(1);
  expect(f[0]).toMatchObject({ location: { path: "pkg/x/b.go", startLine: 10 }, confidence: 0.9, evidence: { command: "go build ./pkg/x", exitCode: 1 } });
  expect(toFindings(cmd, { ...r, timedOut: true }, new Map([["pkg/x/b.go", [9]]]))).toEqual([]);
});

/** Local port: runs commands directly in a temp checkout (tests only; production binds sandboxExecutor to gVisor/Firecracker). */
function localPort(dir: string): ExecutionPort {
  return {
    async run(cmd) {
      for (const [p, c] of Object.entries(cmd.files ?? {})) { await mkdir(dirname(join(dir, p)), { recursive: true }); await writeFile(join(dir, p), c); }
      const argv = cmd.argv.map((a) => a.replace("/workspace/", `${dir}/`)).map((a, i) => (i === 0 && a === "python" ? "python3" : a));
      return exec(argv[0]!, argv.slice(1), { cwd: dir, env: { ...process.env, PYTHONPATH: join(dir, "src") } })
        .then((o) => ({ exitCode: 0, stdout: o.stdout, stderr: o.stderr, timedOut: false }))
        .catch((e: { code?: number | string; stdout?: string; stderr?: string }) => ({ exitCode: typeof e.code === "number" ? e.code : 127, stdout: e.stdout ?? "", stderr: e.stderr ?? "", timedOut: false }));
    },
  };
}

const hasPython = await exec("python3", ["--version"]).then(() => true, () => false);

test.skipIf(!hasPython)("E1 on real python: abstract subclass and syntax error become diff-anchored findings", async () => {
  const dir = await mkdtemp(join(tmpdir(), "e1-"));
  await mkdir(join(dir, "src/app"), { recursive: true });
  await writeFile(join(dir, "src/app/__init__.py"), "");
  await writeFile(join(dir, "src/app/base.py"), "import abc\nclass Base(abc.ABC):\n    @abc.abstractmethod\n    def go(self): ...\n");
  await writeFile(join(dir, "src/app/h.py"), "from app.base import Base\n\nclass H(Base):\n    pass\n");
  await writeFile(join(dir, "src/app/bad.py"), "def f(:\n    pass\n");
  const rep = await validateExecution(localPort(dir), {
    added: new Map([["src/app/h.py", [3, 4]], ["src/app/bad.py", [1]]]), changedPaths: ["src/app/h.py", "src/app/bad.py"],
    classes: [{ path: "src/app/h.py", name: "H" }], levels: ["E0", "E1"],
  });
  const at = rep.findings.map((f) => `${f.level}:${f.location.path}:${f.location.startLine}`);
  expect(at).toContain("E1:src/app/h.py:3");
  expect(at).toContain("E0:src/app/bad.py:1");
  expect(rep.findings.find((f) => f.level === "E1" && f.location.path === "src/app/h.py")!.title).toContain("abstract");
  expect(rep.runs.find((r) => r.label === "mypy")).toBeDefined(); // recorded even if mypy is absent (exit 127 -> skipped)
});
