import { z } from "zod";

/** `cache: true` marks the end of a stable prefix (prompt-cache breakpoint; at most 4 per request on Anthropic). */
export interface ChatMessage { role: "system" | "user" | "assistant" | "tool"; content: string; tool_call_id?: string; cache?: boolean }
export interface ToolSpec { name: string; description: string; parameters: Record<string, unknown> }
export interface ToolCall { name: string; arguments: string }
export interface Usage { inputTokens: number; outputTokens: number; costUsd?: number; cachedTokens?: number; cacheWriteTokens?: number }

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  /** Force a specific tool call (structured output); "required" / "auto" pass through. */
  toolChoice?: string;
  /** Ask for a JSON object response (when tools are not used). */
  jsonMode?: boolean;
  maxTokens?: number;
  temperature?: number;
  /** Sticky-routing key so calls of one review hit the same provider cache (OpenRouter session_id). */
  sessionId?: string;
  signal?: AbortSignal;
}
export interface ChatResult { model: string; content: string | null; toolCalls: ToolCall[]; usage: Usage }
export interface EmbedRequest { model: string; input: string[]; dimensions?: number; signal?: AbortSignal }
export interface EmbedResult { model: string; vectors: number[][]; usage: Usage }

/** One provider endpoint. Implementations must throw ProviderError for HTTP/transport failures. */
export interface LLMProvider {
  readonly name: string;
  chat(req: ChatRequest): Promise<ChatResult>;
  embed(req: EmbedRequest): Promise<EmbedResult>;
}

export class ProviderError extends Error {
  readonly provider: string; readonly status: number | undefined; readonly retryable: boolean;
  constructor(provider: string, message: string, status?: number) {
    super(message);
    this.name = "ProviderError"; this.provider = provider; this.status = status;
    // 408/429/5xx and transport errors (no status) are transient; other 4xx are request bugs.
    this.retryable = status === undefined || status === 408 || status === 429 || status >= 500;
  }
}

const ChatResponse = z.object({
  model: z.string().optional(),
  choices: z.array(z.object({ message: z.object({
    content: z.string().nullable().optional(),
    tool_calls: z.array(z.object({ function: z.object({ name: z.string(), arguments: z.string() }) })).optional(),
  }) })).min(1),
  usage: z.object({ prompt_tokens: z.number(), completion_tokens: z.number(), cost: z.number(),
    prompt_tokens_details: z.object({ cached_tokens: z.number(), cache_write_tokens: z.number() }).partial().nullable() }).partial().optional(),
});
const EmbedResponse = z.object({
  model: z.string().optional(),
  data: z.array(z.object({ index: z.number(), embedding: z.array(z.number()) })),
  usage: z.object({ prompt_tokens: z.number(), total_tokens: z.number() }).partial().optional(),
});

export interface OpenAICompatibleOptions {
  name: string;
  baseUrl: string;
  /** Resolved at call time from env/secret file; never stored in config or logged. */
  apiKey: () => string | undefined;
  headers?: Record<string, string>;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /**
   * OpenRouter-style reasoning control sent with every request. DeepSeek V4.1 Flash otherwise spends the whole max_tokens budget
   * on hidden reasoning and returns finish_reason=length with no tool call (measured: 0/8 hunter+verifier calls valid).
   */
  reasoning?: { enabled: boolean } | { effort: "low" | "medium" | "high" };
  /** Send cache_control content blocks and session_id (OpenRouter/Anthropic). Off for gateways that reject unknown fields. */
  promptCache?: boolean;
}

/** OpenAI-compatible wire messages; cache-marked messages become one text block carrying cache_control. */
export function wireMessages(messages: ChatMessage[], promptCache: boolean): unknown[] {
  return messages.map(({ cache, ...m }) => (promptCache && cache ? { ...m, content: [{ type: "text", text: m.content, cache_control: { type: "ephemeral" } }] } : m));
}

/** Adapter for any OpenAI-compatible /chat/completions + /embeddings API (OpenRouter, Azure OpenAI gateway, vLLM, Bedrock gateway). */
export class OpenAICompatibleProvider implements LLMProvider {
  readonly name: string;
  readonly #o: OpenAICompatibleOptions;
  constructor(o: OpenAICompatibleOptions) { this.name = o.name; this.#o = o; }

  async #post(path: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
    const key = this.#o.apiKey();
    if (!key) throw new ProviderError(this.name, "provider not configured (no API key)", 401);
    const timeout = AbortSignal.timeout(this.#o.timeoutMs ?? 120_000);
    let res: Response;
    try {
      res = await (this.#o.fetch ?? fetch)(`${this.#o.baseUrl.replace(/\/$/, "")}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}`, ...this.#o.headers },
        body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (e) {
      throw new ProviderError(this.name, `transport: ${(e as Error).name}`);
    }
    // Response bodies may echo prompts: never include them in errors.
    if (!res.ok) { await res.body?.cancel().catch(() => undefined); throw new ProviderError(this.name, `HTTP ${res.status}`, res.status); }
    // Some OpenAI-compatible gateways append a `data: [DONE]` SSE trailer even without streaming; strip it.
    const text = await res.text();
    const cut = text.indexOf('data: [DONE]');
    return JSON.parse(cut >= 0 ? text.slice(0, cut) : text);
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    const body = ChatResponse.parse(await this.#post("/chat/completions", {
      model: req.model, messages: wireMessages(req.messages, this.#o.promptCache === true), max_tokens: req.maxTokens ?? 1024, temperature: req.temperature ?? 0,
      ...(this.#o.promptCache && req.sessionId ? { session_id: req.sessionId.slice(0, 256) } : {}),
      ...(this.#o.reasoning ? { reasoning: this.#o.reasoning } : {}),
      ...(req.tools?.length ? { tools: req.tools.map((t) => ({ type: "function", function: t })) } : {}),
      ...(req.toolChoice ? { tool_choice: req.toolChoice === "required" || req.toolChoice === "auto" ? req.toolChoice : { type: "function", function: { name: req.toolChoice } } } : {}),
      ...(req.jsonMode ? { response_format: { type: "json_object" } } : {}),
    }, req.signal));
    const m = body.choices[0]!.message;
    return {
      model: body.model ?? req.model, content: m.content ?? null,
      toolCalls: (m.tool_calls ?? []).map((t) => ({ name: t.function.name, arguments: t.function.arguments })),
      usage: { inputTokens: body.usage?.prompt_tokens ?? 0, outputTokens: body.usage?.completion_tokens ?? 0, ...(body.usage?.cost !== undefined ? { costUsd: body.usage.cost } : {}),
        ...(body.usage?.prompt_tokens_details?.cached_tokens !== undefined ? { cachedTokens: body.usage.prompt_tokens_details.cached_tokens } : {}),
        ...(body.usage?.prompt_tokens_details?.cache_write_tokens !== undefined ? { cacheWriteTokens: body.usage.prompt_tokens_details.cache_write_tokens } : {}) },
    };
  }

  async embed(req: EmbedRequest): Promise<EmbedResult> {
    const body = EmbedResponse.parse(await this.#post("/embeddings", { model: req.model, input: req.input, ...(req.dimensions ? { dimensions: req.dimensions } : {}) }, req.signal));
    const vectors = [...body.data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
    return { model: body.model ?? req.model, vectors, usage: { inputTokens: body.usage?.prompt_tokens ?? 0, outputTokens: 0 } };
  }
}
