import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { TenantConfig } from "@review/core";
import { LocalCodeIndex, memoryRepoSource } from "@review/indexer-worker";
import { MemoryBudgetLedger, MockProvider, ModelRouter, OpenAICompatibleProvider, RoutingPolicy, toolResult, wireMessages, type ChatRequest } from "@review/models";
import { buildContextPack, Candidate, fallbackHypotheses, gitMirrorIndexer, parseDiff, RepoCache, runPipeline, runReview, selectDepth, semgrepSeeds, tierSignals, TIER_WIDTH } from "../src/index.ts";
import { createProducer, memoryTransport } from "@review/queue";
import { ProviderError } from "@review/models";

const exec = promisify(execFile);
const C = "f".repeat(40);
const ix = new LocalCodeIndex(memoryRepoSource({ [C]: { "src/rate.py": "def sample(rate):\n    if rate:\n        return rate\n    return 1.0\n" } }), C);
const DIFF = "diff --git a/src/rate.py b/src/rate.py\n--- /dev/null\n+++ b/src/rate.py\n@@ -0,0 +1,4 @@\n+def sample(rate):\n+    if rate:\n+        return rate\n+    return 1.0\n";
const files = parseDiff(DIFF);
const t = (model: string) => ({ provider: "mock", model, inputUsdPerMTok: 1, outputUsdPerMTok: 1 });
const policy = RoutingPolicy.parse({ tiers: { small: [t("cheap")], medium: [t("standard")], large: [t("frontier")] }, embed: [{ ...t("e"), dimensions: 8 }], retry: { attempts: 1 } });
const cand = (line: number) => Candidate.parse({ category: "bug", severity: "low", title: `bug ${line}`, body: "`if rate:` skips 0.0", location: { path: "src/rate.py", startLine: line, endLine: line }, confidence: 0.8 });

function gated(hypotheses: number) {
  let inFlight = 0, peak = 0;
  const waiters: { tag: string; go: () => void }[] = [];
  const order: string[] = [];
  const mock = new MockProvider("mock", [async (req: ChatRequest) => {
    const sys = req.messages[0]!.content;
    const role = sys.includes("planner") ? "planner" : sys.includes("verifier") ? "verifier" : "hunter";
    order.push(role);
    if (role === "planner") return toolResult("report_hypotheses", { hypotheses: Array.from({ length: hypotheses }, (_, i) => ({ file: "src/rate.py", line: 2, kind: "numeric-truthiness", question: `q${i}` })) });
    const i = Number(/q(\d+)/.exec(req.messages.at(-1)!.content)?.[1] ?? 99);
    inFlight++; peak = Math.max(peak, inFlight);
    await new Promise<void>((go) => waiters.push({ tag: role === "hunter" ? `h${i}` : role, go }));
    inFlight--;
    if (role === "verifier") return toolResult("report_verdict", { keep: true, confidence: 0.9, severity: "low", cited_line: 2, evidence: "`if rate:` treats 0.0 as unset" });
    return toolResult("report_findings", { findings: i === 0 ? [cand(2)] : [] });
  }]);
  const release = (tag?: string) => { for (const w of [...waiters]) if (!tag || w.tag === tag) { waiters.splice(waiters.indexOf(w), 1); w.go(); } };
  return { mock, peak: () => peak, inFlight: () => inFlight, waiting: () => waiters.length, tags: () => waiters.map((w) => w.tag), release, order };
}

const settle = async (pred: () => boolean) => { for (let i = 0; i < 1000 && !pred(); i++) await new Promise((r) => setImmediate(r)); expect(pred()).toBe(true); };

test("hunters run in a bounded pool: peak concurrency == configured width, never more", async () => {
  const g = gated(10);
  const router = new ModelRouter(policy, { providers: [g.mock], budget: new MemoryBudgetLedger({ prUsd: 10, tenantMonthlyUsd: 10 }), sleep: async () => {} });
  const pack = await buildContextPack(ix, files);
  const run = runPipeline({ router, index: ix, scope: { tenantId: "t", reviewId: "r" } }, files, pack, TenantConfig.parse({}), { concurrency: 4 });
  await settle(() => g.waiting() === 4);
  while (g.order.filter((r) => r !== "planner").length < 12) { g.release(); await settle(() => g.waiting() > 0 || g.order.filter((r) => r !== "planner").length >= 12); }
  g.release();
  await settle(() => g.waiting() === 0 && g.inFlight() === 0);
  const r = await run;
  expect(g.peak()).toBe(4);
  expect(r.width).toBe(4);
  expect(r.kept).toHaveLength(1);
  expect(r.llmCalls).toBe(1 + 11 + 1);
});

test("streaming: a verifier starts while other hunters are still running (no hunt->verify barrier)", async () => {
  const g = gated(3);
  const router = new ModelRouter(policy, { providers: [g.mock], budget: new MemoryBudgetLedger({ prUsd: 10, tenantMonthlyUsd: 10 }), sleep: async () => {} });
  const pack = await buildContextPack(ix, files);
  const run = runPipeline({ router, index: ix, scope: { tenantId: "t", reviewId: "r" } }, files, pack, TenantConfig.parse({}), { concurrency: 8 });
  await settle(() => g.waiting() === 4);
  g.release("h0");
  await settle(() => g.tags().includes("verifier"));
  expect(g.tags().sort()).toEqual(["h1", "h2", "h99", "verifier"]);
  g.release();
  await settle(() => g.waiting() === 0 && g.inFlight() === 0);
  expect((await run).kept).toHaveLength(1);
});

test("deterministic-confirmed candidates skip the frontier verifier; tool calls of one round run concurrently", async () => {
  let toolsInFlight = 0, toolPeak = 0;
  const slowIx = Object.create(ix) as typeof ix;
  slowIx.definitions = async (n, o) => { toolsInFlight++; toolPeak = Math.max(toolPeak, toolsInFlight); await new Promise((r) => setImmediate(r)); toolsInFlight--; return ix.definitions(n, o); };
  let first = true;
  const mock = new MockProvider("mock", [(req: ChatRequest) => {
    const sys = req.messages[0]!.content;
    if (sys.includes("planner")) return toolResult("report_hypotheses", { hypotheses: [] });
    if (first) { first = false; return { model: "m", content: null, toolCalls: ["a", "b", "c"].map((s) => ({ name: "get_definition", arguments: JSON.stringify({ symbol: s }) })), usage: { inputTokens: 1, outputTokens: 1 } }; }
    return toolResult("report_findings", { findings: [cand(2)] });
  }]);
  const router = new ModelRouter(policy, { providers: [mock], budget: new MemoryBudgetLedger({ prUsd: 10, tenantMonthlyUsd: 10 }), sleep: async () => {} });
  const pack = await buildContextPack(ix, files);
  const r = await runPipeline({ router, index: slowIx, scope: { tenantId: "t", reviewId: "r" }, deterministic: Promise.resolve([{ path: "src/rate.py", startLine: 3, endLine: 3 }]) }, files, pack, TenantConfig.parse({}));
  expect(toolPeak).toBe(3);
  expect(r.deterministicConfirmed).toBe(1);
  expect(r.kept).toHaveLength(1);
  expect(mock.requests.some((q) => q.messages[0]!.content.includes("verifier"))).toBe(false);
});

test("prompt caching: every hunter/verifier of a review shares one fenced, cache-marked prefix and a session id", async () => {
  const mock = new MockProvider("mock", [(req: ChatRequest) => {
    const sys = req.messages[0]!.content;
    if (sys.includes("planner")) return toolResult("report_hypotheses", { hypotheses: [0, 1].map((i) => ({ file: "src/rate.py", line: 2, kind: "numeric-truthiness", question: `q${i}` })) });
    if (sys.includes("verifier")) return toolResult("report_verdict", { keep: false, confidence: 0.1, severity: "low" });
    return toolResult("report_findings", { findings: [cand(2)] });
  }]);
  const router = new ModelRouter(policy, { providers: [mock], budget: new MemoryBudgetLedger({ prUsd: 10, tenantMonthlyUsd: 10 }), sleep: async () => {} });
  const pack = await buildContextPack(ix, files);
  await runPipeline({ router, index: ix, scope: { tenantId: "t", reviewId: "rev-9" } }, files, pack, TenantConfig.parse({}));
  const hunters = mock.requests.filter((q) => q.messages[0]!.content.includes("bug hunter"));
  expect(hunters.length).toBe(3);
  const prefix = (q: ChatRequest) => JSON.stringify(q.messages.slice(0, 2));
  expect(new Set(hunters.map(prefix)).size).toBe(1);
  expect(hunters[0]!.messages.slice(0, 2).every((m) => m.cache)).toBe(true);
  expect(hunters[0]!.messages[2]!.cache).toBeUndefined();
  const fences = new Set(mock.requests.flatMap((q) => q.messages.flatMap((m) => [...m.content.matchAll(/UNTRUSTED-[0-9a-f]{12}/g)].map((x) => x[0]))));
  expect(fences.size).toBe(1);
  expect(new Set(mock.requests.map((q) => q.sessionId))).toEqual(new Set(["rev-9"]));
});

test("provider wire format: cache_control blocks + session_id only when enabled; cached tokens parsed", async () => {
  const bodies: Record<string, unknown>[] = [];
  const f = (async (_u: string, init: RequestInit) => { bodies.push(JSON.parse(String(init.body))); return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 80, cache_write_tokens: 0 } } })); }) as typeof fetch;
  const msgs = [{ role: "system" as const, content: "S", cache: true }, { role: "user" as const, content: "U" }];
  const on = new OpenAICompatibleProvider({ name: "o", baseUrl: "http://x", apiKey: () => "k", fetch: f, promptCache: true });
  const r = await on.chat({ model: "m", messages: msgs, sessionId: "rev" });
  expect(r.usage).toMatchObject({ inputTokens: 100, cachedTokens: 80, cacheWriteTokens: 0 });
  expect(bodies[0]).toMatchObject({ session_id: "rev", messages: [{ role: "system", content: [{ type: "text", text: "S", cache_control: { type: "ephemeral" } }] }, { role: "user", content: "U" }] });
  await new OpenAICompatibleProvider({ name: "g", baseUrl: "http://x", apiKey: () => "k", fetch: f }).chat({ model: "m", messages: msgs, sessionId: "rev" });
  expect(bodies[1]).not.toHaveProperty("session_id");
  expect(bodies[1]!.messages).toEqual(wireMessages(msgs, false));
  expect(JSON.stringify(bodies[1])).not.toContain("cache");
});

test("auto tier: small PR fast, security path / huge PR deep, explicit depth wins; widths capped by tier", () => {
  const diff = (path: string, n: number) => parseDiff(`diff --git a/${path} b/${path}\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${n} @@\n${Array.from({ length: n }, (_, i) => `+x${i} = ${i}`).join("\n")}\n`);
  expect(selectDepth("auto", tierSignals(diff("app/rate.py", 20))).depth).toBe("fast");
  expect(selectDepth("auto", tierSignals(diff("app/rate.py", 600))).depth).toBe("standard");
  expect(selectDepth("auto", tierSignals(diff("app/rate.py", 2500))).depth).toBe("deep");
  expect(selectDepth("auto", tierSignals(diff("src/auth/login.py", 5))).depth).toBe("deep");
  expect(selectDepth("auto", tierSignals(diff("app/rate.py", 20), 1)).depth).toBe("standard");
  expect(selectDepth("standard", tierSignals(diff("src/auth/login.py", 5)))).toEqual({ depth: "standard", reason: "configured" });
  expect(TIER_WIDTH).toEqual({ fast: 8, standard: 16, deep: 24 });
});

test("repo cache: partial mirror cloned once, missing commit fetched incrementally (not shallow), worktree created and removed; indexer reuses it", async () => {
  const root = await mkdtemp(`${tmpdir()}/rc-`);
  const up = `${root}/upstream`;
  const git = (...a: string[]) => exec("git", ["-c", "user.email=a@b", "-c", "user.name=a", ...a]);
  await git("init", "-q", "-b", "main", up);
  await git("-C", up, "config", "uploadpack.allowFilter", "true");
  await git("-C", up, "config", "uploadpack.allowAnySHA1InWant", "true");
  await writeFile(`${up}/a.py`, "def helper():\n    return 1\n");
  await git("-C", up, "add", "."); await git("-C", up, "commit", "-qm", "1");
  const s1 = (await git("-C", up, "rev-parse", "HEAD")).stdout.trim();
  const cache = new RepoCache(`${root}/mirrors`, { remote: () => `file://${up}`, workspaceRoot: `${root}/ws` });
  const indexer = gitMirrorIndexer(cache);
  const i1 = await indexer.ensureIndexed("acme", s1);
  expect((await i1.definitions("helper"))[0]?.path).toBe("a.py");
  expect(await indexer.ensureIndexed("acme", s1)).toBe(i1);
  await writeFile(`${up}/b.py`, "def other():\n    return helper()\n");
  await git("-C", up, "add", "."); await git("-C", up, "commit", "-qm", "2");
  const s2 = (await git("-C", up, "rev-parse", "HEAD")).stdout.trim();
  await indexer.ensureIndexed("acme", s2);
  expect(cache.counters).toMatchObject({ clones: 1, fetches: 1 });
  expect((await exec("git", ["-C", cache.dir("acme"), "rev-parse", "--is-shallow-repository"])).stdout.trim()).toBe("false");
  expect((await exec("git", ["-C", cache.dir("acme"), "config", "--get", "remote.origin.promisor"])).stdout.trim()).toBe("true");
  const wt = await cache.worktree("acme", s2);
  expect((await exec("git", ["-C", wt.dir, "rev-parse", "HEAD"])).stdout.trim()).toBe(s2);
  await wt.release();
  expect((await exec("git", ["-C", cache.dir("acme"), "worktree", "list"])).stdout.split("\n").filter(Boolean)).toHaveLength(1);
  await expect(indexer.ensureIndexed("../x", s1)).rejects.toThrow(/invalid repository id/);
});

test("per-attempt deadline: a hung call is aborted and falls through to the next target (no multi-minute stall)", async () => {
  const hung = new MockProvider("hung", [(req: ChatRequest) => new Promise((_, reject) => req.signal?.addEventListener("abort", () => reject(new ProviderError("hung", "transport: TimeoutError"))))]);
  const ok = new MockProvider("ok", [toolResult("respond", { n: 1 })]);
  const p = RoutingPolicy.parse({ tiers: { small: [{ ...t("a"), provider: "hung" }, { ...t("b"), provider: "ok" }], medium: [t("m")], large: [t("l")] }, embed: [{ ...t("e"), dimensions: 8 }], retry: { attempts: 1 }, downgrade: false });
  const router = new ModelRouter(p, { providers: [hung, ok], budget: new MemoryBudgetLedger({ prUsd: 10, tenantMonthlyUsd: 10 }), sleep: async () => {} });
  const { z } = await import("zod");
  const r = await router.json("small", [{ role: "user", content: "x" }], z.object({ n: z.number() }), { scope: { tenantId: "t" }, timeoutMs: 20 });
  expect(r.data.n).toBe(1);
  expect(r.result.attempts.map((a) => [a.provider, a.ok])).toEqual([["hung", false], ["ok", true]]);
});

test("planner failure falls back to deterministic hypotheses, so hunters still get focused tasks (recall guard)", async () => {
  const mock = new MockProvider("mock", [(req: ChatRequest) => {
    const sys = req.messages[0]!.content;
    if (sys.includes("planner")) throw new ProviderError("mock", "HTTP 503", 503);
    if (sys.includes("verifier")) return toolResult("report_verdict", { keep: false, confidence: 0.1, severity: "low" });
    return toolResult("report_findings", { findings: [] });
  }]);
  const router = new ModelRouter(policy, { providers: [mock], budget: new MemoryBudgetLedger({ prUsd: 10, tenantMonthlyUsd: 10 }), sleep: async () => {} });
  const pack = await buildContextPack(ix, files);
  const events: Record<string, unknown>[] = [];
  const r = await runPipeline({ router, index: ix, scope: { tenantId: "t", reviewId: "r" }, log: (e) => events.push(e) }, files, pack, TenantConfig.parse({}));
  expect(r.hypotheses.length).toBeGreaterThan(0);
  expect(r.hypotheses).toEqual(fallbackHypotheses(files, pack, 20));
  expect(events.find((e) => e.event === "plan_fallback")).toMatchObject({ hypotheses: r.hypotheses.length });
  expect(mock.requests.filter((q) => q.messages[0]!.content.includes("bug hunter")).length).toBe(1 + r.hypotheses.length);
});

test("semgrep runs before the LLM pipeline; diff-anchored hits become verifier candidates, others are dropped", async () => {
  const sast = [
    { ruleId: "py.eval", message: "eval of user input", path: "src/rate.py", startLine: 2, endLine: 2, severity: "high" as const, cwe: ["CWE-94"], tags: [] },
    { ruleId: "py.far", message: "unrelated", path: "src/other.py", startLine: 50, endLine: 50, severity: "low" as const, cwe: [], tags: [] },
  ];
  expect(semgrepSeeds(sast, new Map([["src/rate.py", [1, 2, 3, 4]]])).map((c) => [c.location.path, c.category])).toEqual([["src/rate.py", "security"]]);
  const order: string[] = [];
  const mock = new MockProvider("mock", [(req: ChatRequest) => {
    const sys = req.messages[0]!.content;
    order.push(sys.includes("planner") ? "planner" : sys.includes("verifier") ? "verifier" : "hunter");
    if (sys.includes("planner")) return toolResult("report_hypotheses", { hypotheses: [] });
    if (sys.includes("verifier")) return toolResult("report_verdict", { keep: true, confidence: 0.9, severity: "high", cited_line: 2, evidence: "`if rate:` is evaluated" });
    return toolResult("report_findings", { findings: [] });
  }]);
  const router = new ModelRouter(policy, { providers: [mock], budget: new MemoryBudgetLedger({ prUsd: 10, tenantMonthlyUsd: 10 }), sleep: async () => {} });
  let scanned: Record<string, string> = {};
  const out = await runReview({ executor: async () => ({ status: "completed", drafts: [], summary: "s", usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: 0 } }),
    producer: createProducer(memoryTransport()), indexer: { ensureIndexed: async () => ix }, router, config: TenantConfig.parse({ learning: false, confidenceThreshold: 0 }),
    semgrep: async (f) => { scanned = f; order.push("semgrep"); return sast; } }, { tenantId: "t", reviewId: "r", repositoryId: "repo", diff: DIFF, headSha: C });
  expect(Object.keys(scanned)).toEqual(["src/rate.py"]);
  expect(order[0]).toBe("semgrep");
  expect(order).toContain("verifier");
  expect(out.findings.map((f) => f.title)).toEqual(["eval of user input"]);
});
