/**
 * Bounded concurrency (LATENCY-PLAN §3): at most `concurrency` tasks run at once, the rest wait FIFO.
 * A finishing task hands its slot straight to the next waiter, so the bound holds without polling.
 */
export interface Limiter {
  <T>(fn: () => Promise<T>): Promise<T>;
  readonly active: number;
  readonly pending: number;
}

export function createLimiter(concurrency: number): Limiter {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new RangeError(`concurrency must be a positive integer, got ${concurrency}`);
  let active = 0;
  const waiting: (() => void)[] = [];
  const run = async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active < concurrency) active++;
    else await new Promise<void>((resolve) => waiting.push(resolve));
    try { return await fn(); } finally {
      const next = waiting.shift();
      if (next) next(); else active--;
    }
  };
  return Object.defineProperties(run, {
    active: { get: () => active },
    pending: { get: () => waiting.length },
  }) as Limiter;
}
