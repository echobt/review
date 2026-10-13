export class BudgetExceededError extends Error {
  readonly scope: "pr" | "tenant";
  constructor(scope: "pr" | "tenant", message: string) { super(message); this.name = "BudgetExceededError"; this.scope = scope; }
}

export interface BudgetScope { tenantId: string; reviewId?: string }

/** Budget ledger port. Production persists to usage_ledger; the in-memory one serves tests and single-process runs. */
export interface BudgetLedger {
  /** Reserve an estimated cost before a call. Throws BudgetExceededError if either cap would be exceeded. */
  reserve(scope: BudgetScope, estimateUsd: number): Promise<void>;
  /** Replace the reservation with the actual cost after the call (or 0 on failure). */
  settle(scope: BudgetScope, estimateUsd: number, actualUsd: number): Promise<void>;
  remaining(scope: BudgetScope): Promise<{ pr: number; tenant: number }>;
}

export interface BudgetCaps { prUsd: number; tenantMonthlyUsd: number }

export class MemoryBudgetLedger implements BudgetLedger {
  readonly #caps: (tenantId: string) => BudgetCaps;
  readonly #tenant = new Map<string, number>();
  readonly #pr = new Map<string, number>();
  constructor(caps: BudgetCaps | ((tenantId: string) => BudgetCaps)) { this.#caps = typeof caps === "function" ? caps : () => caps; }
  #prKey = (s: BudgetScope) => `${s.tenantId}/${s.reviewId ?? "-"}`;
  async reserve(s: BudgetScope, est: number) {
    const caps = this.#caps(s.tenantId);
    const t = this.#tenant.get(s.tenantId) ?? 0;
    const p = this.#pr.get(this.#prKey(s)) ?? 0;
    if (t + est > caps.tenantMonthlyUsd) throw new BudgetExceededError("tenant", `tenant monthly budget ${caps.tenantMonthlyUsd} USD exhausted`);
    if (s.reviewId && p + est > caps.prUsd) throw new BudgetExceededError("pr", `per-PR budget ${caps.prUsd} USD exhausted`);
    this.#tenant.set(s.tenantId, t + est);
    if (s.reviewId) this.#pr.set(this.#prKey(s), p + est);
  }
  async settle(s: BudgetScope, est: number, actual: number) {
    this.#tenant.set(s.tenantId, (this.#tenant.get(s.tenantId) ?? 0) - est + actual);
    if (s.reviewId) this.#pr.set(this.#prKey(s), (this.#pr.get(this.#prKey(s)) ?? 0) - est + actual);
  }
  async remaining(s: BudgetScope) {
    const caps = this.#caps(s.tenantId);
    return { pr: caps.prUsd - (this.#pr.get(this.#prKey(s)) ?? 0), tenant: caps.tenantMonthlyUsd - (this.#tenant.get(s.tenantId) ?? 0) };
  }
}

/** Cheap pre-call token estimate (~4 chars/token). Reconciled with provider usage after the call. */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);
