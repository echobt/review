/** Consecutive-failure circuit breaker: closed -> open (after N failures) -> half-open (after cooldown, one probe). */
export class CircuitBreaker {
  readonly #threshold: number; readonly #cooldownMs: number; readonly #now: () => number;
  #failures = 0; #openedAt: number | undefined; #probing = false;
  constructor(opts: { failureThreshold?: number; cooldownMs?: number; now?: () => number } = {}) {
    this.#threshold = opts.failureThreshold ?? 5; this.#cooldownMs = opts.cooldownMs ?? 30_000; this.#now = opts.now ?? Date.now;
  }
  get state(): "closed" | "open" | "half-open" {
    if (this.#openedAt === undefined) return "closed";
    return this.#now() - this.#openedAt >= this.#cooldownMs ? "half-open" : "open";
  }
  /** True if a call may proceed. In half-open, admits a single probe. */
  allow(): boolean {
    const s = this.state;
    if (s === "closed") return true;
    if (s === "half-open" && !this.#probing) { this.#probing = true; return true; }
    return false;
  }
  success() { this.#failures = 0; this.#openedAt = undefined; this.#probing = false; }
  failure() {
    this.#probing = false;
    if (this.#openedAt !== undefined) { this.#openedAt = this.#now(); return; } // failed probe: re-open
    if (++this.#failures >= this.#threshold) this.#openedAt = this.#now();
  }
}
