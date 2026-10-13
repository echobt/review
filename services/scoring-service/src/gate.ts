import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { regressionGate } from "@review/scoring-client";
import { ScoreReport } from "@review/core";

/** CI gate: node src/gate.ts --baseline a.json --candidate b.json [--max-score-drop 1 --max-swr-drop 0.02 --max-precision-drop 0.02] */
export function gate(argv: string[]): { pass: boolean; reasons: string[] } {
  const { values: v } = parseArgs({ args: argv, options: {
    baseline: { type: "string" }, candidate: { type: "string" },
    "max-score-drop": { type: "string" }, "max-swr-drop": { type: "string" }, "max-precision-drop": { type: "string" },
  } });
  if (!v.baseline || !v.candidate) throw new Error("usage: gate.ts --baseline a.json --candidate b.json");
  const load = (p: string) => ScoreReport.parse(JSON.parse(readFileSync(p, "utf8")));
  const num = (s: string | undefined) => (s === undefined ? undefined : Number(s));
  const opts = Object.fromEntries(Object.entries({ maxScoreDrop: num(v["max-score-drop"]), maxSwrDrop: num(v["max-swr-drop"]),
    maxPrecisionDrop: num(v["max-precision-drop"]) }).filter(([, x]) => x !== undefined));
  return regressionGate(load(v.baseline), load(v.candidate), opts);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const r = gate(process.argv.slice(2));
  console.log(r.pass ? "score gate: PASS" : `score gate: FAIL\n${r.reasons.map((x) => `- ${x}`).join("\n")}`);
  process.exitCode = r.pass ? 0 : 1;
}
