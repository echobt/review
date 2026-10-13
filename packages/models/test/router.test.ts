import { expect, test } from "vitest";
import { z } from "zod";
import {
  AllTargetsFailedError, BudgetExceededError, CircuitBreaker, MemoryBudgetLedger, MockProvider, ModelRouter, OpenAICompatibleProvider,
  ProviderError, RoutingPolicy, hashEmbeddings, toolResult, type ChatResult,
} from "../src/index.ts";

const T = (provider: string, model: string, price = 1) => ({ provider, model, inputUsdPerMTok: price, outputUsdPerMTok: price });
const policy = RoutingPolicy.parse({
  tiers: { small: [T("a", "s1")], medium: [T("a", "m1"), T("b", "m2")], large: [T("a", "l1")] },
  embed: [{ ...T("a", "e1"), dimensions: 8 }],
  retry: { attempts: 2, baseDelayMs: 100, maxDelayMs: 1000 },
});
const ok = (content = "ok"): ChatResult => ({ model: "x", content, toolCalls: [], usage: { inputTokens: 1000, outputTokens: 1000 } });
const scope = { tenantId: "t1", reviewId: "r1" };
const big = { prUsd: 100, tenantMonthlyUsd: 1000 };
const sleeps: number[] = [];
const deps = (providers: MockProvider[], budget = new MemoryBudgetLedger(big)) => ({ providers, budget, sleep: async (ms: number) => { sleeps.push(ms); }, random: () => 0.5 });

test("routes tier to first target and computes cost from price table", async () => {
  const a = new MockProvider("a", [ok()]);
  const r = await new ModelRouter(policy, deps([a])).chat("small", [{ role: "user", content: "hi" }], { scope });
  expect([r.provider, r.tier, a.requests[0]!.model]).toEqual(["a", "small", "s1"]);
  expect(r.costUsd).toBeCloseTo(2000 / 1e6);
});

test("retries transient error with jittered backoff, then falls back to next provider", async () => {
  sleeps.length = 0;
  const a = new MockProvider("a", [new ProviderError("a", "HTTP 503", 503)]);
  const b = new MockProvider("b", [ok("from-b")]);
  const r = await new ModelRouter(policy, deps([a, b])).chat("medium", [{ role: "user", content: "x" }], { scope });
  expect(r.provider).toBe("b");
  expect(a.requests).toHaveLength(2); // 1 retry
  expect(sleeps).toEqual([50]); // floor(0.5 * min(1000, 100 * 2^0))
  expect(r.attempts.map((x) => x.ok)).toEqual([false, false, true]);
});

test("non-retryable 400 stops immediately without trying other providers", async () => {
  const a = new MockProvider("a", [new ProviderError("a", "HTTP 400", 400)]);
  const b = new MockProvider("b", [ok()]);
  await expect(new ModelRouter(policy, deps([a, b])).chat("medium", [], { scope })).rejects.toBeInstanceOf(AllTargetsFailedError);
  expect(b.requests).toHaveLength(0);
});

test("missing key (401) skips to the next provider", async () => {
  const a = new MockProvider("a", [new ProviderError("a", "not configured", 401)]);
  const b = new MockProvider("b", [ok()]);
  expect((await new ModelRouter(policy, deps([a, b])).chat("medium", [], { scope })).provider).toBe("b");
  expect(a.requests).toHaveLength(1);
});

test("downgrades tier when the whole tier fails", async () => {
  const a = new MockProvider("a", [(req) => { if (req.model === "l1") throw new ProviderError("a", "HTTP 502", 502); return ok(); }]);
  const r = await new ModelRouter(policy, deps([a])).chat("large", [], { scope });
  expect([r.tier, a.requests.at(-1)!.model]).toEqual(["medium", "m1"]);
});

test("per-PR budget: reserve blocks calls that would exceed cap; actual cost reconciled", async () => {
  const budget = new MemoryBudgetLedger({ prUsd: 0.0025, tenantMonthlyUsd: 10 });
  const router = new ModelRouter(policy, deps([new MockProvider("a", [ok()])], budget));
  await router.chat("small", [], { scope, maxTokens: 1000 }); // est 0.001, actual 0.002
  expect((await budget.remaining(scope)).pr).toBeCloseTo(0.0005);
  await expect(router.chat("small", [], { scope, maxTokens: 1000 })).rejects.toBeInstanceOf(BudgetExceededError);
  // another PR of the same tenant still has budget
  await router.chat("small", [], { scope: { tenantId: "t1", reviewId: "r2" }, maxTokens: 1000 });
});

test("per-tenant monthly budget applies across PRs", async () => {
  const budget = new MemoryBudgetLedger({ prUsd: 1, tenantMonthlyUsd: 0.0025 });
  const router = new ModelRouter(policy, deps([new MockProvider("a", [ok()])], budget));
  await router.chat("small", [], { scope: { tenantId: "t9", reviewId: "x" }, maxTokens: 1000 });
  const e = await router.chat("small", [], { scope: { tenantId: "t9", reviewId: "y" }, maxTokens: 1000 }).catch((x) => x);
  expect(e).toBeInstanceOf(BudgetExceededError);
  expect(e.scope).toBe("tenant");
});

test("failed calls release their reservation", async () => {
  const budget = new MemoryBudgetLedger({ prUsd: 1, tenantMonthlyUsd: 1 });
  await expect(new ModelRouter(policy, deps([new MockProvider("a", [new ProviderError("a", "x", 503)])], budget)).chat("small", [], { scope })).rejects.toThrow();
  expect((await budget.remaining(scope)).tenant).toBe(1);
});

test("circuit breaker opens after threshold, short-circuits, and half-opens after cooldown", async () => {
  let now = 0;
  const a = new MockProvider("a", [new ProviderError("a", "HTTP 500", 500)]);
  const b = new MockProvider("b", [ok()]);
  const router = new ModelRouter({ ...policy, retry: { attempts: 1, baseDelayMs: 0, maxDelayMs: 1 } }, { ...deps([a, b]), now: () => now, breaker: { failureThreshold: 2, cooldownMs: 1000 } });
  await router.chat("medium", [], { scope });
  await router.chat("medium", [], { scope });
  expect(router.breaker("a", "m1").state).toBe("open");
  const before = a.requests.length;
  const r = await router.chat("medium", [], { scope });
  expect(a.requests.length).toBe(before); // skipped while open
  expect(r.attempts[0]!.error).toBe("circuit open");
  now = 1000;
  expect(router.breaker("a", "m1").state).toBe("half-open");
  await router.chat("medium", [], { scope });
  expect(a.requests.length).toBe(before + 1); // single probe
});

test("CircuitBreaker unit: success closes", () => {
  let now = 0;
  const br = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 10, now: () => now });
  br.failure(); expect(br.allow()).toBe(false);
  now = 10; expect(br.allow()).toBe(true); expect(br.allow()).toBe(false);
  br.success(); expect(br.state).toBe("closed");
});

test("json(): forced tool call parsed with zod, one repair round on invalid output", async () => {
  const Schema = z.object({ verdict: z.enum(["tp", "fp"]) });
  const a = new MockProvider("a", [toolResult("respond", { verdict: "maybe" }), toolResult("respond", { verdict: "tp" })]);
  const { data } = await new ModelRouter(policy, deps([a])).json("small", [{ role: "user", content: "triage" }], Schema, { scope });
  expect(data.verdict).toBe("tp");
  expect(a.requests[0]!.toolChoice).toBe("respond");
  expect(a.requests[1]!.messages.at(-1)!.content).toMatch(/invalid/);
});

test("embed(): dimension-checked vectors from the embed route", async () => {
  const a = new MockProvider("a");
  const r = await new ModelRouter(policy, deps([a])).embed(["function foo", "function foo"], { scope });
  expect(r.vectors).toHaveLength(2);
  expect(r.vectors[0]).toHaveLength(8);
  expect(r.vectors[0]).toEqual(r.vectors[1]);
  const h = hashEmbeddings({ model: "x", input: ["a b"], dimensions: 16 }).vectors[0]!;
  expect(Math.hypot(...h)).toBeCloseTo(1);
});

test("OpenAICompatibleProvider: request shape, auth header, error never leaks body", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = (async (u: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(u), init: init! });
    if (calls.length === 2) return new Response("echo: secret prompt", { status: 429 });
    return Response.json({ model: "m", choices: [{ message: { content: null, tool_calls: [{ function: { name: "respond", arguments: "{}" } }] } }], usage: { prompt_tokens: 3, completion_tokens: 4, cost: 0.5 } });
  }) as typeof fetch;
  const p = new OpenAICompatibleProvider({ name: "or", baseUrl: "https://x.test/v1/", apiKey: () => "k1", fetch: f });
  const r = await p.chat({ model: "m", messages: [{ role: "user", content: "hi" }], tools: [{ name: "respond", description: "d", parameters: {} }], toolChoice: "respond" });
  expect(calls[0]!.url).toBe("https://x.test/v1/chat/completions");
  expect(new Headers(calls[0]!.init.headers).get("authorization")).toBe("Bearer k1");
  const body = JSON.parse(String(calls[0]!.init.body));
  expect(body.tool_choice).toEqual({ type: "function", function: { name: "respond" } });
  expect(r.usage).toEqual({ inputTokens: 3, outputTokens: 4, costUsd: 0.5 });
  const err = await p.chat({ model: "m", messages: [] }).catch((e) => e);
  expect(err).toBeInstanceOf(ProviderError);
  expect([err.status, err.retryable]).toEqual([429, true]);
  expect(err.message).not.toContain("secret");
  const none = new OpenAICompatibleProvider({ name: "or", baseUrl: "https://x.test", apiKey: () => undefined, fetch: f });
  expect((await none.chat({ model: "m", messages: [] }).catch((e) => e)).status).toBe(401);
});
