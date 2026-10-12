import { z } from "zod";
import type { ModelTier } from "@review/core";
import { CircuitBreaker } from "./breaker.ts";
import { BudgetExceededError, estimateTokens, type BudgetLedger, type BudgetScope } from "./budget.ts";
import { ProviderError, type ChatMessage, type ChatResult, type LLMProvider, type ToolSpec } from "./provider.ts";

export const RouteTarget = z.object({
  provider: z.string(), model: z.string(),
  inputUsdPerMTok: z.number().nonnegative(), outputUsdPerMTok: z.number().nonnegative(),
});
export type RouteTarget = z.infer<typeof RouteTarget>;
export const EmbedTarget = RouteTarget.extend({ dimensions: z.number().int().positive() });
export type EmbedTarget = z.infer<typeof EmbedTarget>;

export const RoutingPolicy = z.object({
  tiers: z.object({ small: z.array(RouteTarget).min(1), medium: z.array(RouteTarget).min(1), large: z.array(RouteTarget).min(1) }),
  embed: z.array(EmbedTarget).min(1),
  /** Downgrade order when a tier fails or its estimate does not fit the budget. */
  downgrade: z.boolean().default(true),
  retry: z.object({ attempts: z.number().int().min(1).max(5).default(2), baseDelayMs: z.number().int().nonnegative().default(250), maxDelayMs: z.number().int().positive().default(4000) }).default({ attempts: 2, baseDelayMs: 250, maxDelayMs: 4000 }),
});
export type RoutingPolicy = z.infer<typeof RoutingPolicy>;

/** Tier defaults (ADR 0006 + GREPTILE-GAP §6.3): three distinct models, cheap < standard < frontier. Prices are USD per 1M tokens. */
export const DEFAULT_TIER_MODELS = {
  small: { model: "deepseek/deepseek-v4.1-flash", inputUsdPerMTok: 0.1, outputUsdPerMTok: 0.4 },
  medium: { model: "anthropic/claude-sonnet-4.5", inputUsdPerMTok: 3, outputUsdPerMTok: 15 },
  large: { model: "openai/gpt-5", inputUsdPerMTok: 1.25, outputUsdPerMTok: 10 },
} as const;

/**
 * Policy from env (model ids are config, never code): MODEL_PROVIDER (default openrouter), MODEL_SMALL / MODEL_MEDIUM / MODEL_LARGE
 * (comma-separated = fallback chain),
 * optional MODEL_<TIER>_PRICE="in,out" (USD per 1M tokens; defaults to the tier default price). Tenants still override per agent kind.
 */
export function policyFromEnv(env: NodeJS.ProcessEnv = process.env): RoutingPolicy {
  const provider = env.MODEL_PROVIDER || "openrouter";
  const target = (tier: ModelTier) => {
    const d = DEFAULT_TIER_MODELS[tier];
    const key = `MODEL_${tier.toUpperCase()}`;
    const price = env[`${key}_PRICE`]?.split(",").map(Number);
    const ok = price?.length === 2 && price.every((x) => Number.isFinite(x) && x >= 0);
    // Comma-separated ids form the tier's fallback chain (tried in order, each behind its own circuit breaker).
    const models = (env[key] || d.model).split(",").map((m) => m.trim()).filter(Boolean);
    return models.map((model) => ({ provider, model, inputUsdPerMTok: ok ? price[0]! : d.inputUsdPerMTok, outputUsdPerMTok: ok ? price[1]! : d.outputUsdPerMTok }));
  };
  return RoutingPolicy.parse({
    tiers: { small: target("small"), medium: target("medium"), large: target("large") },
    embed: [{ provider: env.EMBED_PROVIDER || "openrouter", model: env.EMBED_MODEL || "openai/text-embedding-3-small", inputUsdPerMTok: 0.02, outputUsdPerMTok: 0, dimensions: 1024 }],
  });
}

/** Default policy without env overrides. */
export const defaultPolicy: RoutingPolicy = policyFromEnv({});

export interface Attempt { provider: string; model: string; tier: ModelTier; ok: boolean; error?: string; costUsd: number; latencyMs: number }
export interface RoutedResult extends ChatResult { provider: string; tier: ModelTier; costUsd: number; attempts: Attempt[] }

export class AllTargetsFailedError extends Error {
  readonly attempts: Attempt[];
  constructor(message: string, attempts: Attempt[]) { super(message); this.name = "AllTargetsFailedError"; this.attempts = attempts; }
}

export interface RouterDeps {
  providers: LLMProvider[];
  budget: BudgetLedger;
  /** Injected for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
  breaker?: { failureThreshold?: number; cooldownMs?: number };
}

export interface CallOptions {
  scope: BudgetScope;
  maxTokens?: number;
  tools?: ToolSpec[];
  toolChoice?: string;
  jsonMode?: boolean;
  signal?: AbortSignal;
}

const DOWNGRADE: Record<ModelTier, ModelTier | undefined> = { large: "medium", medium: "small", small: undefined };
const cost = (t: RouteTarget, inTok: number, outTok: number) => (inTok * t.inputUsdPerMTok + outTok * t.outputUsdPerMTok) / 1e6;

/**
 * Tier router (ADR 0006): per target -> breaker check -> budget reserve -> call with jittered exponential
 * retry on transient errors -> settle actual cost. Falls through targets of the tier, then downgrades tier.
 * Non-retryable 4xx stops immediately (request bug; another provider would fail the same way).
 */
export class ModelRouter {
  readonly policy: RoutingPolicy;
  readonly #providers: Map<string, LLMProvider>;
  readonly #budget: BudgetLedger;
  readonly #breakers = new Map<string, CircuitBreaker>();
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #random: () => number;
  readonly #now: () => number;
  readonly #breakerOpts: RouterDeps["breaker"];

  constructor(policy: RoutingPolicy, deps: RouterDeps) {
    this.policy = RoutingPolicy.parse(policy);
    this.#providers = new Map(deps.providers.map((p) => [p.name, p]));
    this.#budget = deps.budget;
    this.#sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.#random = deps.random ?? Math.random;
    this.#now = deps.now ?? Date.now;
    this.#breakerOpts = deps.breaker;
  }

  breaker(provider: string, model: string): CircuitBreaker {
    const k = `${provider}/${model}`;
    let b = this.#breakers.get(k);
    if (!b) { b = new CircuitBreaker({ ...this.#breakerOpts, now: this.#now }); this.#breakers.set(k, b); }
    return b;
  }

  /** Full-jitter exponential backoff: uniform(0, min(max, base * 2^attempt)). */
  backoffMs(attempt: number): number {
    const r = this.policy.retry;
    return Math.floor(this.#random() * Math.min(r.maxDelayMs, r.baseDelayMs * 2 ** attempt));
  }

  async chat(tier: ModelTier, messages: ChatMessage[], opts: CallOptions): Promise<RoutedResult> {
    const attempts: Attempt[] = [];
    const inTok = estimateTokens(messages.map((m) => m.content).join("\n"));
    const outTok = opts.maxTokens ?? 1024;
    let budgetErr: BudgetExceededError | undefined;
    for (let t: ModelTier | undefined = tier; t; t = this.policy.downgrade ? DOWNGRADE[t] : undefined) {
      for (const target of this.policy.tiers[t]) {
        const provider = this.#providers.get(target.provider);
        const br = this.breaker(target.provider, target.model);
        if (!provider) { attempts.push({ provider: target.provider, model: target.model, tier: t, ok: false, error: "provider not registered", costUsd: 0, latencyMs: 0 }); continue; }
        if (!br.allow()) { attempts.push({ provider: target.provider, model: target.model, tier: t, ok: false, error: "circuit open", costUsd: 0, latencyMs: 0 }); continue; }
        const est = cost(target, inTok, outTok);
        try { await this.#budget.reserve(opts.scope, est); } catch (e) {
          if (e instanceof BudgetExceededError) { budgetErr = e; attempts.push({ provider: target.provider, model: target.model, tier: t, ok: false, error: `budget: ${e.scope}`, costUsd: 0, latencyMs: 0 }); continue; }
          throw e;
        }
        for (let i = 0; i < this.policy.retry.attempts; i++) {
          const t0 = this.#now();
          try {
            const r = await provider.chat({ model: target.model, messages, maxTokens: outTok,
              ...(opts.tools ? { tools: opts.tools } : {}), ...(opts.toolChoice ? { toolChoice: opts.toolChoice } : {}),
              ...(opts.jsonMode ? { jsonMode: true } : {}), ...(opts.signal ? { signal: opts.signal } : {}) });
            const actual = r.usage.costUsd ?? cost(target, r.usage.inputTokens, r.usage.outputTokens);
            await this.#budget.settle(opts.scope, est, actual);
            br.success();
            attempts.push({ provider: provider.name, model: target.model, tier: t, ok: true, costUsd: actual, latencyMs: this.#now() - t0 });
            return { ...r, provider: provider.name, tier: t, costUsd: actual, attempts };
          } catch (e) {
            const pe = e instanceof ProviderError ? e : new ProviderError(provider.name, (e as Error).message);
            attempts.push({ provider: provider.name, model: target.model, tier: t, ok: false, error: pe.message, costUsd: 0, latencyMs: this.#now() - t0 });
            // Auth/config failure is specific to this provider: skip to the next target without tripping the breaker.
            if (pe.status === 401 || pe.status === 403) break;
            if (!pe.retryable) { await this.#budget.settle(opts.scope, est, 0); throw new AllTargetsFailedError(`non-retryable: ${pe.provider} ${pe.message}`, attempts); }
            br.failure();
            if (i + 1 < this.policy.retry.attempts && br.allow()) await this.#sleep(this.backoffMs(i));
            else break;
          }
        }
        await this.#budget.settle(opts.scope, est, 0);
      }
    }
    if (budgetErr && attempts.every((a) => a.error?.startsWith("budget"))) throw budgetErr;
    throw new AllTargetsFailedError(`all targets failed for tier ${tier}: ${attempts.map((a) => `${a.provider}/${a.model}: ${a.error}`).join("; ")}`, attempts);
  }

  /**
   * Structured output: forces a tool call whose arguments must parse with the zod schema.
   * One repair round re-asks with the validation error (not the content) appended.
   */
  async json<T>(tier: ModelTier, messages: ChatMessage[], schema: z.ZodType<T>, opts: CallOptions & { toolName?: string; description?: string }): Promise<{ data: T; result: RoutedResult }> {
    const name = opts.toolName ?? "respond";
    const tool: ToolSpec = { name, description: opts.description ?? "Return the structured result.", parameters: z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as Record<string, unknown> };
    let msgs = messages;
    let last: RoutedResult | undefined;
    for (let round = 0; round < 2; round++) {
      last = await this.chat(tier, msgs, { ...opts, tools: [tool], toolChoice: name });
      const raw = last.toolCalls.find((c) => c.name === name)?.arguments ?? last.content ?? "";
      // Models often wrap JSON in prose or fences; extract the outermost object so validation (not parsing) decides.
      let parsed: unknown;
      try { parsed = JSON.parse(raw); } catch {
        const s = raw.indexOf("{"); const e = raw.lastIndexOf("}");
        try { parsed = s >= 0 && e > s ? JSON.parse(raw.slice(s, e + 1)) : undefined; } catch { parsed = undefined; }
      }
      const r = schema.safeParse(parsed);
      if (r.success) return { data: r.data, result: last };
      msgs = [...messages, { role: "user", content: `Your previous ${name} call was invalid: ${r.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}. Call ${name} again with valid arguments.` }];
    }
    throw new Error(`structured output failed validation after repair (${last?.provider}/${last?.model})`);
  }

  async embed(input: string[], opts: { scope: BudgetScope; signal?: AbortSignal }): Promise<{ vectors: number[][]; model: string; dimensions: number; costUsd: number }> {
    const errors: string[] = [];
    for (const target of this.policy.embed) {
      const provider = this.#providers.get(target.provider);
      const br = this.breaker(target.provider, target.model);
      if (!provider || !br.allow()) { errors.push(`${target.provider}: unavailable`); continue; }
      const est = cost(target, estimateTokens(input.join("\n")), 0);
      await this.#budget.reserve(opts.scope, est);
      try {
        const r = await provider.embed({ model: target.model, input, dimensions: target.dimensions, ...(opts.signal ? { signal: opts.signal } : {}) });
        if (r.vectors.some((v) => v.length !== target.dimensions)) throw new ProviderError(provider.name, `dimension mismatch (want ${target.dimensions})`, 400);
        const actual = r.usage.costUsd ?? cost(target, r.usage.inputTokens, 0);
        await this.#budget.settle(opts.scope, est, actual);
        br.success();
        return { vectors: r.vectors, model: target.model, dimensions: target.dimensions, costUsd: actual };
      } catch (e) {
        await this.#budget.settle(opts.scope, est, 0);
        br.failure();
        errors.push(`${target.provider}/${target.model}: ${(e as Error).message}`);
      }
    }
    throw new Error(`embedding failed: ${errors.join("; ")}`);
  }
}
