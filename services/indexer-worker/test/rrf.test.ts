import { expect, test } from "vitest";
import { rrf } from "../src/retrieval.ts";

test("rrf scores and order", () => {
  // a: 1/61 + 1/62; b: 1/62 + 1/61; c: 1/63 + 1/61 (rank 1 in list 3); d: 1/61
  const r = rrf([["a", "b", "c"], ["b", "a"], ["c"]]);
  expect(r.map((x) => x.id)).toEqual(["a", "b", "c"]);
  expect(r[0]!.score).toBeCloseTo(1 / 61 + 1 / 62, 12);
  expect(r[2]!.score).toBeCloseTo(1 / 63 + 1 / 61, 12);
  // a and b tie exactly -> id ascending
  expect(r[0]!.score).toBe(r[1]!.score);
});

test("rrf tie-break deterministic by id and k matters", () => {
  expect(rrf([["z"], ["y"], ["x"]]).map((x) => x.id)).toEqual(["x", "y", "z"]);
  expect(rrf([["p", "q"], ["q"]], 1).map((x) => [x.id, x.score])).toEqual([["q", 1 / 3 + 1 / 2], ["p", 1 / 2]]);
});
