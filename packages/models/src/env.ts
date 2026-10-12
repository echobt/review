import { readFileSync } from "node:fs";
import { OpenAICompatibleProvider, type LLMProvider } from "./provider.ts";

const secret = (name: string, env: NodeJS.ProcessEnv) => () => {
  if (env[name]) return env[name];
  const f = env[`${name}_FILE`];
  return f ? readFileSync(f, "utf8").trim() || undefined : undefined;
};

/** Providers configured from env. Keys are read lazily at call time; absent keys make the provider fail closed (401, non-retryable). */
export function providersFromEnv(env: NodeJS.ProcessEnv = process.env, f?: typeof fetch): LLMProvider[] {
  const timeout = Number(env.MODEL_TIMEOUT_MS) || undefined;
  const out: LLMProvider[] = [
    new OpenAICompatibleProvider({ name: "openrouter", baseUrl: env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1", apiKey: secret("OPENROUTER_API_KEY", env), ...(timeout ? { timeoutMs: timeout } : {}), ...(f ? { fetch: f } : {}) }),
  ];
  // Any OpenAI-compatible gateway (e.g. an internal LLM gateway); select it with MODEL_PROVIDER=gateway.
  if (env.GATEWAY_BASE_URL) out.push(new OpenAICompatibleProvider({ name: "gateway", baseUrl: env.GATEWAY_BASE_URL, apiKey: secret("GATEWAY_API_KEY", env), ...(timeout ? { timeoutMs: timeout } : {}), ...(f ? { fetch: f } : {}) }));
  if (env.VLLM_BASE_URL) out.push(new OpenAICompatibleProvider({ name: "vllm", baseUrl: env.VLLM_BASE_URL, apiKey: () => secret("VLLM_API_KEY", env)() ?? "none", ...(f ? { fetch: f } : {}) }));
  if (env.AZURE_OPENAI_BASE_URL) out.push(new OpenAICompatibleProvider({ name: "azure-openai", baseUrl: env.AZURE_OPENAI_BASE_URL, apiKey: secret("AZURE_OPENAI_API_KEY", env), ...(f ? { fetch: f } : {}) }));
  return out;
}
