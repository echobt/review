import { z } from "zod";
import type { ModelTier } from "@review/core";

// OpenAI-compatible provider abstraction with per-tier routing, budget caps and fallback.

export const Provider = z.object({
  name: z.string(),
  baseUrl: z.string().url(),
  /** Env var holding the key (value read at call time, never stored in config). */
  apiKeyEnv: z.string(),
  extraHeaders: z.record(z.string(), z.string()).default({}),
});
export type Provider = z.infer<typeof Provider>;

export const RouteTarget = z.object({ provider: z.string(), model: z.string(), inputUsdPerMTok: z.number().nonnegative(), outputUsdPerMTok: z.number().nonnegative() });
export const RoutingPolicy = z.object({
  providers: z.array(Provider).min(1),
  tiers: z.record(z.enum(["cheap", "standard", "frontier"]), z.array(RouteTarget).min(1)),
});
export type RoutingPolicy = z.infer<typeof RoutingPolicy>;

/** Default policy. Model ids are config, not code: tenants override via DB (PROPOSAL, see ADR-0006). */
export const defaultPolicy: RoutingPolicy = RoutingPolicy.parse({
  providers: [{ name: "openrouter", baseUrl: "https://openrouter.ai/api/v1", apiKeyEnv: "OPENROUTER_API_KEY" }],
  tiers: {
    cheap: [{ provider: "openrouter", model: "deepseek/deepseek-v4.1-flash", inputUsdPerMTok: 0, outputUsdPerMTok: 0 }],
    standard: [{ provider: "openrouter", model: "deepseek/deepseek-v4.1-flash", inputUsdPerMTok: 0, outputUsdPerMTok: 0 }],
    frontier: [{ provider: "openrouter", model: "deepseek/deepseek-v4.1-flash", inputUsdPerMTok: 0, outputUsdPerMTok: 0 }],
  },
});

export interface ChatMessage { role: "system" | "user" | "assistant"; content: string }
export interface ToolSpec { name: string; description: string; parameters: Record<string, unknown> }
export interface CompletionResult { model: string; provider: string; content: string | null; toolArguments: string | null; inputTokens: number; outputTokens: number; costUsd: number }

const ChatResponse = z.object({
  model: z.string().optional(),
  choices: z.array(z.object({ message: z.object({
    content: z.string().nullable().optional(),
    tool_calls: z.array(z.object({ function: z.object({ name: z.string(), arguments: z.string() }) })).optional(),
  }) })).min(1),
  usage: z.object({ prompt_tokens: z.number(), completion_tokens: z.number(), cost: z.number().optional() }).partial().optional(),
});

export class BudgetExceededError extends Error {}

export class ModelRouter {
  #spentUsd = 0;
  readonly policy: RoutingPolicy;
  readonly budgetUsd: number;
  readonly env: NodeJS.ProcessEnv;
  readonly fetchImpl: typeof fetch;
  constructor(policy: RoutingPolicy, budgetUsd: number, env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = globalThis.fetch) {
    this.policy = policy; this.budgetUsd = budgetUsd; this.env = env; this.fetchImpl = fetchImpl;
  }

  get spentUsd() { return this.#spentUsd; }

  /** Try each target of the tier in order; fall back on transport/5xx/429 errors. */
  async complete(tier: ModelTier, messages: ChatMessage[], opts: { tool?: ToolSpec; maxTokens?: number } = {}): Promise<CompletionResult> {
    if (this.#spentUsd >= this.budgetUsd) throw new BudgetExceededError(`budget ${this.budgetUsd} USD exhausted`);
    const errors: string[] = [];
    for (const target of this.policy.tiers[tier] ?? []) {
      const provider = this.policy.providers.find((p) => p.name === target.provider);
      const key = provider && this.env[provider.apiKeyEnv];
      if (!provider || !key) { errors.push(`${target.provider}: not configured`); continue; }
      const res = await this.fetchImpl(`${provider.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}`, ...provider.extraHeaders },
        body: JSON.stringify({
          model: target.model, messages, max_tokens: opts.maxTokens ?? 1024, temperature: 0,
          ...(opts.tool ? { tools: [{ type: "function", function: opts.tool }], tool_choice: { type: "function", function: { name: opts.tool.name } } } : {}),
        }),
        signal: AbortSignal.timeout(120_000),
      }).catch((e: unknown) => { errors.push(`${target.provider}/${target.model}: ${String(e)}`); return undefined; });
      if (!res) continue;
      if (!res.ok) {
        errors.push(`${target.provider}/${target.model}: HTTP ${res.status}`);
        if (res.status === 429 || res.status >= 500) continue;
        break; // 4xx other than 429 = request problem, do not fall back
      }
      const body = ChatResponse.parse(await res.json());
      const msg = body.choices[0]!.message;
      const inTok = body.usage?.prompt_tokens ?? 0, outTok = body.usage?.completion_tokens ?? 0;
      const cost = body.usage?.cost ?? (inTok * target.inputUsdPerMTok + outTok * target.outputUsdPerMTok) / 1e6;
      this.#spentUsd += cost;
      return { model: body.model ?? target.model, provider: provider.name, content: msg.content ?? null,
        toolArguments: msg.tool_calls?.[0]?.function.arguments ?? null, inputTokens: inTok, outputTokens: outTok, costUsd: cost };
    }
    throw new Error(`all targets failed for tier ${tier}: ${errors.join("; ")}`);
  }
}
