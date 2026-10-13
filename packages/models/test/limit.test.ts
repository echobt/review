import { expect, test } from "vitest";
import { createLimiter } from "../src/index.ts";

const deferred = () => { let resolve!: () => void; const p = new Promise<void>((r) => { resolve = r; }); return { p, resolve }; };

test("limiter never exceeds its bound, runs FIFO, and releases slots on rejection", async () => {
  const limit = createLimiter(2);
  const gates = Array.from({ length: 5 }, deferred);
  const started: number[] = [];
  let inFlight = 0, peak = 0;
  const runs = gates.map((g, i) => limit(async () => {
    started.push(i); inFlight++; peak = Math.max(peak, inFlight);
    await g.p;
    inFlight--;
    if (i === 1) throw new Error("boom");
    return i;
  }));
  await Promise.resolve();
  expect(started).toEqual([0, 1]);
  expect([limit.active, limit.pending]).toEqual([2, 3]);
  gates[1]!.resolve();
  await expect(runs[1]).rejects.toThrow("boom");
  expect(started).toEqual([0, 1, 2]);
  for (const g of gates) g.resolve();
  expect(await Promise.all([runs[0], runs[2], runs[3], runs[4]])).toEqual([0, 2, 3, 4]);
  expect(started).toEqual([0, 1, 2, 3, 4]);
  expect(peak).toBe(2);
  expect([limit.active, limit.pending]).toEqual([0, 0]);
});

test("limiter rejects a non-positive bound", () => {
  expect(() => createLimiter(0)).toThrow(RangeError);
  expect(() => createLimiter(1.5)).toThrow(RangeError);
});
