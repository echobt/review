import { expect, test } from "vitest";
import { MemoryBudgetLedger, MockProvider, ModelRouter, defaultPolicy, policyFromEnv, providersFromEnv, toolResult } from "../src/index.ts";

test("default policy maps small/medium/large to three distinct models, cheap tier = deepseek-v4.1-flash", () => {
  const ids = (["small", "medium", "large"] as const).map((t) => defaultPolicy.tiers[t][0]!.model);
  expect(new Set(ids).size).toBe(3);
  expect(ids[0]).toBe("deepseek/deepseek-v4.1-flash");
});

test("policyFromEnv reads provider, model ids and prices from env; invalid price falls back to default", () => {
  const p = policyFromEnv({ MODEL_PROVIDER: "gateway", MODEL_SMALL: "s", MODEL_MEDIUM: "m", MODEL_LARGE: "l", MODEL_LARGE_PRICE: "2,8", MODEL_MEDIUM_PRICE: "x" });
  expect(p.tiers.small[0]).toMatchObject({ provider: "gateway", model: "s" });
  expect(p.tiers.large[0]).toMatchObject({ model: "l", inputUsdPerMTok: 2, outputUsdPerMTok: 8 });
  expect(p.tiers.medium[0]!.inputUsdPerMTok).toBe(3);
  expect(policyFromEnv({ MODEL_SMALL: "a, b" }).tiers.small.map((x) => x.model)).toEqual(["a", "b"]);
});

test("each tier routes to its own model; downgrade/fallback still applies", async () => {
  const p = policyFromEnv({ MODEL_PROVIDER: "mock", MODEL_SMALL: "s", MODEL_MEDIUM: "m", MODEL_LARGE: "l" });
  const mock = new MockProvider("mock", [toolResult("x", {})]);
  const r = new ModelRouter(p, { providers: [mock], budget: new MemoryBudgetLedger({ prUsd: 10, tenantMonthlyUsd: 10 }), sleep: async () => {} });
  for (const t of ["small", "medium", "large"] as const) await r.chat(t, [{ role: "user", content: "hi" }], { scope: { tenantId: "t" } });
  expect(mock.requests.map((q) => q.model)).toEqual(["s", "m", "l"]);
});

test("gateway provider registered only when GATEWAY_BASE_URL is set; key read lazily from env/_FILE", () => {
  expect(providersFromEnv({}).map((p) => p.name)).toEqual(["openrouter"]);
  expect(providersFromEnv({ GATEWAY_BASE_URL: "http://gw.test/v1" }).map((p) => p.name)).toEqual(["openrouter", "gateway"]);
});
