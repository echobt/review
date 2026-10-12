import { expect, test } from "vitest";
import { applyLearnedRules, clusterGlob, learnSuppressionRules, type FeedbackEvent } from "../src/index.ts";

const ev = (verdict: FeedbackEvent["verdict"], o: Partial<FeedbackEvent> = {}): FeedbackEvent => ({ category: "style", severity: "low", path: "src/app/x.py", verdict, ...o });

test("learned suppression: >=5 dismissals at >=80% becomes a rule; security and high/critical never count or get suppressed", () => {
  expect(clusterGlob("src/app/deep/x.py")).toBe("src/app/**/*.py");
  const four = [...Array(4)].map(() => ev("dismissed"));
  expect(learnSuppressionRules(four)).toEqual([]);
  const rules = learnSuppressionRules([...four, ev("thumbs_down", { path: "src/app/y.py" }), ev("resolved")]);
  expect(rules).toEqual([expect.objectContaining({ category: "style", pathGlob: "src/app/**/*.py", dismissals: 5, total: 6 })]);
  expect(learnSuppressionRules([...four, ev("dismissed"), ev("resolved"), ev("resolved")])).toEqual([]); // 5/7 < 80%
  expect(learnSuppressionRules([...Array(6)].map(() => ev("dismissed", { category: "security" })))).toEqual([]);
  const loc = (path: string) => ({ path, startLine: 1, endLine: 1 });
  const out = applyLearnedRules([
    { category: "style", severity: "low", location: loc("src/app/z.py") },
    { category: "style", severity: "high", location: loc("src/app/z.py") },
    { category: "style", severity: "low", location: loc("lib/z.py") },
  ], rules);
  expect(out.suppressed.map((f) => f.location.path)).toEqual(["src/app/z.py"]);
  expect(out.kept.map((f) => f.severity)).toEqual(["high", "low"]);
});
