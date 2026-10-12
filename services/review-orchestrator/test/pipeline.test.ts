import { expect, test } from "vitest";
import { TenantConfig } from "@review/core";
import { LocalCodeIndex, memoryRepoSource } from "@review/indexer-worker";
import { MemoryBudgetLedger, MockProvider, ModelRouter, RoutingPolicy, toolResult, type ChatRequest } from "@review/models";
import { createProducer, memoryTransport } from "@review/queue";
import type { ExecCommand } from "@review/sandbox-runner";
import { buildContextPack, Candidate, runReview, fileGroups, grounded, hunterTier, parseDiff, runPipeline, runTool } from "../src/index.ts";

const C = "e".repeat(40);
const repo = {
  "src/base.py": "class Base:\n    def run(self):\n        raise NotImplementedError\n",
  "src/rate.py": "def sample(rate):\n    if rate:\n        return rate\n    return 1.0\n",
};
const DIFF = `diff --git a/src/rate.py b/src/rate.py
--- /dev/null
+++ b/src/rate.py
@@ -0,0 +1,4 @@
+def sample(rate):
+    if rate:
+        return rate
+    return 1.0
`;
const ix = new LocalCodeIndex(memoryRepoSource({ [C]: repo }), C);
const files = parseDiff(DIFF);
const cand: Candidate = Candidate.parse({ category: "bug", severity: "low", title: "0.0 rate treated as missing", body: "`if rate:` skips 0.0", location: { path: "src/rate.py", startLine: 2, endLine: 2 }, confidence: 0.8 });

// Tiers map to distinct models so the test can assert role -> tier routing.
const t = (model: string) => ({ provider: "mock", model, inputUsdPerMTok: 1, outputUsdPerMTok: 1 });
const policy = RoutingPolicy.parse({ tiers: { small: [t("cheap")], medium: [t("standard")], large: [t("frontier")] }, embed: [{ ...t("e"), dimensions: 8 }], retry: { attempts: 1 } });

function script(verdictEvidence: string) {
  let toolUsed = false;
  return (req: ChatRequest) => {
    const sys = req.messages[0]!.content;
    if (sys.includes("planner")) return toolResult("report_hypotheses", { hypotheses: [{ file: "src/rate.py", line: 2, kind: "numeric-truthiness", question: "Is 0.0 a valid rate?" }, { file: "nope.py", line: 1, kind: "consistency", question: "x" }] });
    if (sys.includes("verifier")) return toolResult("report_verdict", { keep: true, confidence: 0.9, severity: "low", cited_line: 2, evidence: verdictEvidence });
    // First hunter turn calls a tool, then reports.
    if (!toolUsed && sys.includes("focused bug hunter")) { toolUsed = true; return toolResult("get_definition", { symbol: "Base" }); }
    return toolResult("report_findings", { findings: [cand] });
  };
}

test("planner -> hunters (with tool loop) -> grounded verifier; roles routed to cheap/standard/frontier", async () => {
  const mock = new MockProvider("mock", [script("`if rate:` treats 0.0 as unset")]);
  const router = new ModelRouter(policy, { providers: [mock], budget: new MemoryBudgetLedger({ prUsd: 10, tenantMonthlyUsd: 10 }), sleep: async () => {} });
  const pack = await buildContextPack(ix, files);
  const r = await runPipeline({ router, index: ix, scope: { tenantId: "t", reviewId: "r" } }, files, pack, TenantConfig.parse({}));
  expect(r.hypotheses.map((h) => h.file)).toEqual(["src/rate.py"]); // unknown file dropped
  expect(r.kept).toHaveLength(1);
  expect(r.kept[0]).toMatchObject({ title: cand.title, confidence: 0.9, location: { path: "src/rate.py", startLine: 2 } });
  expect(r.failures).toBe(0);
  const models = (k: string) => mock.requests.filter((q) => q.messages[0]!.content.includes(k)).map((q) => q.model);
  expect(new Set(models("planner"))).toEqual(new Set(["cheap"]));
  expect(new Set(models("bug hunter"))).toEqual(new Set(["standard"]));
  expect(new Set(models("verifier"))).toEqual(new Set(["frontier"]));
  // The tool result (definition of Base) was fed back to the hunter.
  expect(mock.requests.some((q) => q.messages.some((m) => m.content.includes("src/base.py:1-3")))).toBe(true);
});

test("ungrounded verdict (evidence not in repo) is dropped", async () => {
  const mock = new MockProvider("mock", [script("`if threshold is falsy then crash` happens")]);
  const router = new ModelRouter(policy, { providers: [mock], budget: new MemoryBudgetLedger({ prUsd: 10, tenantMonthlyUsd: 10 }), sleep: async () => {} });
  const pack = await buildContextPack(ix, files);
  const r = await runPipeline({ router, index: ix, scope: { tenantId: "t", reviewId: "r" } }, files, pack, TenantConfig.parse({}));
  expect(r.candidates.length).toBeGreaterThan(0);
  expect(r.kept).toEqual([]);
});

test("grounding rule, tiers, groups and tools", async () => {
  const v = { keep: true, confidence: 0.9, severity: "low" as const, cited_line: 2, evidence: "`if rate:`" };
  expect(grounded(v, cand, ["    if rate:"])).toBe(true);
  expect(grounded({ ...v, cited_line: 40 }, cand, ["    if rate:"])).toBe(false);
  expect(grounded({ ...v, keep: false }, cand, ["    if rate:"])).toBe(false);
  expect(hunterTier({ file: "a", line: 1, kind: "security", question: "q" }, "deep")).toBe("large");
  expect(hunterTier({ file: "a", line: 1, kind: "security", question: "q" }, "standard")).toBe("medium");
  const many = parseDiff(Array.from({ length: 8 }, (_, i) => `diff --git a/d/f${i}.py b/d/f${i}.py\n--- a/d/f${i}.py\n+++ b/d/f${i}.py\n@@ -1 +1 @@\n-a\n+b\n`).join(""));
  expect(fileGroups(many).map((g) => g.length)).toEqual([6, 2]);
  expect(await runTool(ix, "read_file", JSON.stringify({ path: "src/rate.py", start: 2, end: 2 }))).toBe("    2      if rate:");
  expect(await runTool(ix, "get_definition", JSON.stringify({ symbol: "x.Base" }))).toContain("src/base.py:1-3 (class)");
  expect(await runTool(ix, "find_references", "{bad")).toBe("error: invalid arguments");
});

test("runReview selects the multi-agent engine with indexer+router+headSha; execution E1/E3 evidence upgrades the finding to hybrid", async () => {
  const withTest = Candidate.parse({ ...cand, test: { path: "tests/test_rate.py", content: "def test_zero():\n    assert False\n" } });
  const base = script("`if rate:` treats 0.0 as unset");
  const mock = new MockProvider("mock", [(req: ChatRequest) => { const r = base(req); return r.toolCalls[0]!.name === "report_findings" ? toolResult("report_findings", { findings: [withTest] }) : r; }]);
  const router = new ModelRouter(policy, { providers: [mock], budget: new MemoryBudgetLedger({ prUsd: 10, tenantMonthlyUsd: 10 }), sleep: async () => {} });
  const ran: ExecCommand[] = [];
  const execution = async () => ({ async run(cmd: ExecCommand) {
    ran.push(cmd);
    return cmd.level === "E3" ? { exitCode: 1, stdout: "1 failed", stderr: "", timedOut: false } : { exitCode: 0, stdout: "", stderr: "", timedOut: false };
  } });
  const deps = { executor: async () => ({ status: "failed" as const, drafts: [], usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: 0 } }),
    producer: createProducer(memoryTransport()), indexer: { ensureIndexed: async () => ix }, router, execution, config: TenantConfig.parse({ learning: false }) };
  const out = await runReview(deps, { tenantId: "t", reviewId: "r", repositoryId: "repo", diff: DIFF, headSha: C });
  expect(out.engine).toBe("multi-agent");
  expect(out.stats).toMatchObject({ hypotheses: 1, verified: 1, failures: 0 });
  expect(ran.map((c) => c.level)).toEqual(expect.arrayContaining(["E0", "E1", "E3"]));
  expect(out.findings).toHaveLength(1);
  expect(out.findings[0]).toMatchObject({ source: "hybrid", confidence: 0.9, evidence: { command: expect.stringContaining("tests/test_rate.py"), exitCode: 1 } });
  // No headSha -> legacy single-pass agents.
  await expect(runReview(deps, { tenantId: "t", reviewId: "r2", repositoryId: "repo", diff: DIFF })).rejects.toThrow(/review agents failed/);
});
