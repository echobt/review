import { test } from "node:test";
import assert from "node:assert/strict";
import { ModelRouter, RoutingPolicy, BudgetExceededError } from "../src/index.ts";

const policy = RoutingPolicy.parse({
  providers: [
    { name: "a", baseUrl: "https://a.test/v1", apiKeyEnv: "A_KEY" },
    { name: "b", baseUrl: "https://b.test/v1", apiKeyEnv: "B_KEY" },
  ],
  tiers: { cheap: [{ provider: "a", model: "m1", inputUsdPerMTok: 1, outputUsdPerMTok: 2 }, { provider: "b", model: "m2", inputUsdPerMTok: 1, outputUsdPerMTok: 2 }],
    standard: [{ provider: "b", model: "m2", inputUsdPerMTok: 0, outputUsdPerMTok: 0 }], frontier: [{ provider: "b", model: "m2", inputUsdPerMTok: 0, outputUsdPerMTok: 0 }] },
});
const ok = (args: string) => Response.json({ model: "m2", choices: [{ message: { content: null, tool_calls: [{ function: { name: "t", arguments: args } }] } }], usage: { prompt_tokens: 1000, completion_tokens: 500 } });

test("falls back to next target on 503 and computes cost from price table", async () => {
  const hits: string[] = [];
  const f = (async (u: string | URL | Request) => { hits.push(String(u)); return String(u).startsWith("https://a") ? new Response("", { status: 503 }) : ok("{}"); }) as typeof fetch;
  const r = await new ModelRouter(policy, 1, { A_KEY: "x", B_KEY: "y" }, f).complete("cheap", [{ role: "user", content: "hi" }]);
  assert.equal(r.provider, "b"); assert.equal(hits.length, 2);
  assert.equal(r.costUsd, (1000 * 1 + 500 * 2) / 1e6);
});

test("does not fall back on 400", async () => {
  let n = 0;
  const f = (async () => { n++; return new Response("", { status: 400 }); }) as typeof fetch;
  await assert.rejects(new ModelRouter(policy, 1, { A_KEY: "x", B_KEY: "y" }, f).complete("cheap", []), /HTTP 400/);
  assert.equal(n, 1);
});

test("skips unconfigured provider and enforces budget", async () => {
  const f = (async () => ok("{}")) as typeof fetch;
  const router = new ModelRouter(policy, 0.0015, { B_KEY: "y" }, f);
  await router.complete("cheap", []);
  assert.ok(router.spentUsd >= 0.0015);
  await assert.rejects(router.complete("cheap", []), BudgetExceededError);
});
