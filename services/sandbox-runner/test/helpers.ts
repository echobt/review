import { MemoryBudgetLedger, MockProvider, ModelRouter, RoutingPolicy } from "@review/models";

export const TENANT = "11111111-1111-4111-8111-111111111111";

export function mockRouter(provider: MockProvider): ModelRouter {
  const t = [{ provider: provider.name, model: "mock", inputUsdPerMTok: 0, outputUsdPerMTok: 0 }];
  const policy = RoutingPolicy.parse({ tiers: { small: t, medium: t, large: t }, embed: [{ ...t[0], dimensions: 8 }], retry: { attempts: 1, baseDelayMs: 0 } });
  return new ModelRouter(policy, { providers: [provider], budget: new MemoryBudgetLedger({ prUsd: 10, tenantMonthlyUsd: 10 }), sleep: async () => {} });
}
