import { expect, test } from "vitest";
import type { Finding } from "@review/core";
import { createTestGenRecord, getTestGenRecord, withTenant } from "@review/db";
import { createTestDatabase } from "@review/db/testing";
import { MockProvider, toolResult } from "@review/models";
import { MockSandboxDriver, type ValidSpec } from "../src/sandbox.ts";
import { COVERAGE_LCOV, COVERAGE_SUMMARY, coveredLines, filterTests, generateTests, type Candidate, type TestRun } from "../src/testgen.ts";
import { mockRouter } from "./helpers.ts";

const cand = (name: string): Candidate => ({ name, path: `test/${name}.test.ts`, content: `// ${name}\n` });

test("filterTests keeps only building, passing, deterministic, coverage-increasing tests", () => {
  const table: [string, TestRun[], string | undefined][] = [
    ["build-fail", [{ outcome: "build", output: "" }, { outcome: "build", output: "" }], "build-failed"],
    ["test-fail", [{ outcome: "assertion", output: "" }, { outcome: "assertion", output: "" }], "test-failed"],
    ["flaky", [{ outcome: "pass", output: "", coveredLines: 20 }, { outcome: "assertion", output: "" }], "flaky"],
    ["no-gain", [{ outcome: "pass", output: "", coveredLines: 10 }, { outcome: "pass", output: "", coveredLines: 10 }], "no-coverage-gain"],
    ["single-run", [{ outcome: "pass", output: "", coveredLines: 20 }], "not-run"],
    ["good", [{ outcome: "pass", output: "", coveredLines: 12 }, { outcome: "pass", output: "", coveredLines: 12 }], undefined],
  ];
  const r = filterTests(table.map(([n]) => cand(n)), Object.fromEntries(table.map(([n, runs]) => [n, runs])), 10);
  expect(r.kept.map((c) => c.name)).toEqual(["good"]);
  expect(Object.fromEntries(r.discarded.map((d) => [d.candidate.name, d.reason]))).toEqual(Object.fromEntries(table.filter(([, , why]) => why).map(([n, , why]) => [n, why])));
});

test("coveredLines reads istanbul json-summary and lcov", () => {
  expect(coveredLines({ [COVERAGE_SUMMARY]: Buffer.from(JSON.stringify({ total: { lines: { total: 50, covered: 31, pct: 62 } } })) })).toBe(31);
  expect(coveredLines({ [COVERAGE_LCOV]: Buffer.from("SF:a.ts\nLH:4\nLF:9\nend_of_record\nSF:b.ts\nLH:3\nend_of_record\n") })).toBe(7);
  expect(coveredLines({})).toBeUndefined();
});

/** Scripted test runner: file content drives the outcome; COV=n sets covered lines. */
function runner() {
  return new MockSandboxDriver((s: ValidSpec) => {
    const path = s.command[1];
    const src = path ? String(s.files?.[path] ?? "") : "";
    const cov = Number(/COV=(\d+)/.exec(src)?.[1] ?? 10);
    const files = { [COVERAGE_SUMMARY]: Buffer.from(JSON.stringify({ total: { lines: { covered: cov } } })) };
    if (src.includes("ASSERT_FAIL")) return { exitCode: 1, stderr: "AssertionError: expected 1 to be 2", files };
    if (src.includes("SYNTAX")) return { exitCode: 1, stderr: "SyntaxError: Unexpected token", files };
    return { exitCode: 0, stdout: "1 passed", files };
  });
}

const finding: Finding = { id: "f1", reviewId: "r1", category: "bug", severity: "high", title: "off-by-one in sum", body: "Loop skips last item.",
  location: { path: "src/sum.ts", startLine: 2, endLine: 2 }, related: [], confidence: 0.7, source: "llm", cwe: [] };

test("full loop: repair fixes failing test, reproducer upgrades finding, patch adds kept tests, record updated", async () => {
  const { db, newTenant } = await createTestDatabase();
  const tenantId = await newTenant();
  const rec = await withTenant(db, tenantId, (sql) => createTestGenRecord(sql, tenantId, { repositoryId: "repo", targetPaths: ["src/sum.ts"] }));
  const provider = new MockProvider("mock", [
    toolResult("plan", { targets: [{ name: "sum", path: "test/sum.test.ts", intent: "cover sum" }, { name: "repro", path: "test/repro.test.ts", intent: "reproduce", findingId: "f1" }] }),
    toolResult("generate", { tests: [
      { name: "sum", path: "test/sum.test.ts", content: "expect(sum([1])).toBe(2) // ASSERT_FAIL\n" },
      { name: "repro", path: "test/repro.test.ts", content: "expect(sum([1,2])).toBe(3) // ASSERT_FAIL\n", findingId: "f1" },
    ] }),
    toolResult("repair", { tests: [{ name: "sum", path: "test/sum.test.ts", content: "expect(sum([1])).toBe(1) // COV=14\n" }] }),
  ]);
  const driver = runner();
  const r = await generateTests(mockRouter(provider), driver, { tenantId, reviewId: "r1", repositoryId: "repo", targetPaths: ["src/sum.ts"], files: { "src/sum.ts": "export const sum = ..." },
    image: "node:24", command: (p) => (p ? ["vitest", p] : ["vitest"]), findings: [finding], db, testGenId: rec.id });

  expect(r.iterations).toBe(2);
  expect(r.kept.map((c) => c.name)).toEqual(["sum"]);
  expect(r.discarded).toEqual([{ candidate: expect.objectContaining({ name: "repro" }), reason: "test-failed" }]);
  expect(r.reproducers).toEqual([{ findingId: "f1", test: "repro" }]);
  expect(r.findings[0]).toMatchObject({ confidence: 0.95, body: expect.stringContaining("Reproduced by generated test repro") });
  expect(r.coverageDelta).toBe(4);
  expect(r.patch).toBe("--- /dev/null\n+++ b/test/sum.test.ts\n@@ -0,0 +1,1 @@\n+expect(sum([1])).toBe(1) // COV=14\n");
  expect(provider.requests.map((q) => q.toolChoice)).toEqual(["plan", "generate", "repair"]);
  // baseline + 2 runs x (2 initial + 1 repaired)
  expect(driver.calls).toHaveLength(7);
  const stored = await withTenant(db, tenantId, (sql) => getTestGenRecord(sql, rec.id));
  expect(stored).toMatchObject({ status: "completed", testsKept: 1, testsDiscarded: 1, coverageDelta: 4 });
}, 60_000);

test("repair rounds are capped at 3 and build errors never count as reproducers", async () => {
  const bad = { tests: [{ name: "t", path: "test/t.test.ts", content: "SYNTAX", findingId: "f1" }] };
  const provider = new MockProvider("mock", [toolResult("plan", { targets: [] }), toolResult("generate", bad), toolResult("repair", bad)]);
  const r = await generateTests(mockRouter(provider), runner(), { tenantId: "t", reviewId: "r", repositoryId: "repo", targetPaths: [], files: {}, image: "node:24",
    command: (p) => (p ? ["vitest", p] : ["vitest"]), findings: [finding], maxIterations: 99 });
  expect(r.iterations).toBe(4);
  expect(provider.requests.filter((q) => q.toolChoice === "repair")).toHaveLength(3);
  expect(r.reproducers).toEqual([]);
  expect(r.findings[0]!.confidence).toBe(0.7);
  expect(r.discarded[0]!.reason).toBe("build-failed");
  expect(r.patch).toBe("");
});
