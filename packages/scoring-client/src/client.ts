import { Dataset, Leaderboard, Rubric } from "./schemas.ts";

export interface ScoringClientOptions {
  /** Raw content base of the public repo. */
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
}

export const DEFAULT_SCORING_BASE = "https://raw.githubusercontent.com/echobt/code-review-scoring/main";

/** Read-only client for the PUBLIC scoring repo. Needs no credentials. */
export class ScoringClient {
  readonly #base: string;
  readonly #fetch: typeof globalThis.fetch;
  constructor(opts: ScoringClientOptions = {}) {
    this.#base = (opts.baseUrl ?? DEFAULT_SCORING_BASE).replace(/\/$/, "");
    this.#fetch = opts.fetch ?? globalThis.fetch;
  }
  async #get(path: string): Promise<unknown> {
    const res = await this.#fetch(`${this.#base}/${path}`);
    if (!res.ok) throw new Error(`scoring repo: HTTP ${res.status} for ${path}`);
    return res.json();
  }
  async rubric(version = "1.0.0") { return Rubric.parse(await this.#get(`rubric/rubric.v${version}.json`)); }
  async dataset(version: string) { return Dataset.parse(await this.#get(`datasets/${version}/dataset.json`)); }
  async leaderboard() { return Leaderboard.parse(await this.#get("leaderboard/leaderboard.json")); }
}
