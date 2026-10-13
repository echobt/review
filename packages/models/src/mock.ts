import { createHash } from "node:crypto";
import { ProviderError, type ChatRequest, type ChatResult, type EmbedRequest, type EmbedResult, type LLMProvider } from "./provider.ts";

type Scripted = ChatResult | ProviderError | ((req: ChatRequest) => ChatResult | Promise<ChatResult>);

/** Scriptable provider for tests: responses are consumed in order; the last one repeats. Records every request. */
export class MockProvider implements LLMProvider {
  readonly name: string;
  readonly requests: ChatRequest[] = [];
  readonly #script: Scripted[];
  #i = 0;
  constructor(name: string, script: Scripted[] = []) { this.name = name; this.#script = script; }
  async chat(req: ChatRequest): Promise<ChatResult> {
    this.requests.push(req);
    const s = this.#script[Math.min(this.#i++, this.#script.length - 1)];
    if (!s) throw new ProviderError(this.name, "no scripted response", 500);
    if (s instanceof ProviderError) throw s;
    return typeof s === "function" ? s(req) : s;
  }
  async embed(req: EmbedRequest): Promise<EmbedResult> { return hashEmbeddings(req); }
}

/** Convenience: a successful tool-call response. */
export const toolResult = (name: string, args: unknown, usage = { inputTokens: 100, outputTokens: 50 }): ChatResult =>
  ({ model: "mock", content: null, toolCalls: [{ name, arguments: JSON.stringify(args) }], usage });

/**
 * Deterministic local embeddings: feature-hashed token unigrams + bigrams, L2-normalised. Offline, free,
 * reproducible; similarity reflects lexical overlap. Used for tests and RUNTIME_MODE=memory.
 */
export function hashEmbeddings(req: EmbedRequest): EmbedResult {
  const dim = req.dimensions ?? 1024;
  const vectors = req.input.map((text) => {
    const v = new Array<number>(dim).fill(0);
    // Identifiers contribute the whole token plus camelCase/snake_case sub-words, so "compute invoice" matches computeInvoiceTotal.
    const toks = (text.match(/[A-Za-z_][A-Za-z0-9_]*|\d+/g) ?? []).flatMap((w) => {
      const parts = w.split(/_|(?<=[a-z0-9])(?=[A-Z])/).filter(Boolean).map((p) => p.toLowerCase());
      return parts.length > 1 ? [w.toLowerCase(), ...parts] : [w.toLowerCase()];
    });
    const feats = [...toks, ...toks.slice(1).map((t, i) => `${toks[i]}|${t}`)];
    for (const f of feats) {
      const h = createHash("sha1").update(f).digest();
      v[h.readUInt32BE(0) % dim]! += h[4]! & 1 ? 1 : -1;
    }
    const n = Math.hypot(...v) || 1;
    return v.map((x) => x / n);
  });
  return { model: req.model, vectors, usage: { inputTokens: req.input.reduce((s, t) => s + Math.ceil(t.length / 4), 0), outputTokens: 0, costUsd: 0 } };
}

export class HashEmbeddingProvider implements LLMProvider {
  readonly name: string;
  constructor(name = "local-hash") { this.name = name; }
  async chat(): Promise<ChatResult> { throw new ProviderError(this.name, "chat not supported by local-hash provider", 400); }
  async embed(req: EmbedRequest) { return hashEmbeddings(req); }
}
