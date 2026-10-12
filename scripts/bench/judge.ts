// Greptile-rule judge (GREPTILE-GAP §1.2): caught = a line-anchored finding (<= 10 lines) within +/-3 lines of the labelled
// location (or an acceptAlso site) AND a judge says it names the same defect and its impact. Summary text never counts.
// Usage: node scripts/bench/judge.ts --run bench-runs/<name> [--dataset ...] [--votes 3]
//   With MODEL_* / gateway env set, the semantic check is an LLM judge on MODEL_LARGE (temperature fixed by the provider, majority of --votes).
//   Without a model (--no-llm), the semantic check is keyword overlap with the bug description (>= 1 key term); recorded per case.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { MemoryBudgetLedger, ModelRouter, policyFromEnv, providersFromEnv } from "@review/models";

export interface Loc { path: string; startLine: number; endLine: number }
export interface Bug { description: string; location: Loc; acceptAlso?: Loc[]; keyTerms?: string[] }
export interface F { title: string; body: string; location: Loc }

/** Location rule: same path, span <= 10 lines, overlapping the label widened by +/-3. */
export function locationHit(bug: Bug, f: F, tol = 3, maxSpan = 10): boolean {
  if (f.location.endLine - f.location.startLine + 1 > maxSpan) return false;
  return [bug.location, ...(bug.acceptAlso ?? [])].some((l) => l.path === f.location.path && f.location.startLine <= l.endLine + tol && f.location.endLine >= l.startLine - tol);
}
export const keywordHit = (bug: Bug, f: F) => (bug.keyTerms ?? []).some((t) => `${f.title} ${f.body}`.toLowerCase().includes(t.toLowerCase()));

const arg = (k: string, d?: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
if (import.meta.url === `file://${process.argv[1]}`) {
  const run = arg("--run")!;
  const ds = JSON.parse(readFileSync(arg("--dataset", new URL("../../docs/scoring/datasets/greptile-50/dataset.json", import.meta.url).pathname)!, "utf8")) as { cases: { id: string; bugs: Bug[] }[] };
  const useLlm = !process.argv.includes("--no-llm");
  const votes = Number(arg("--votes", "3"));
  const router = useLlm ? new ModelRouter(policyFromEnv(), { providers: providersFromEnv(), budget: new MemoryBudgetLedger({ prUsd: 100, tenantMonthlyUsd: 1000 }) }) : undefined;
  const V = z.object({ same_defect: z.boolean(), explains_impact: z.boolean() });
  let judgeCost = 0;
  const results = [];
  for (const file of readdirSync(run).filter((f) => /^[a-z]+-\d+\.json$/.test(f)).sort()) {
    const rec = JSON.parse(readFileSync(`${run}/${file}`, "utf8")) as { caseId: string; ok: boolean; findings: F[]; usage?: { costUsd: number }; latencyMs: number };
    const c = ds.cases.find((x) => x.id === rec.caseId);
    if (!c) continue;
    const bug = c.bugs[0]!;
    const near = rec.findings.filter((f) => locationHit(bug, f));
    let caughtBy: F | undefined, method = "none";
    for (const f of near) {
      if (router) {
        let yes = 0;
        for (let v = 0; v < votes; v++) {
          const { data, result } = await router.json("large", [
            { role: "system", content: "You grade an automated code review against a known bug. Answer strictly." },
            { role: "user", content: JSON.stringify({ known_bug: bug.description, labelled_location: bug.location, review_comment: { title: f.title, body: f.body, location: f.location } }) + "\nDoes the review comment identify the same defect as the known bug (same root cause at that code), and does it explain the impact?" },
          ], V, { scope: { tenantId: "bench-judge" }, toolName: "grade" });
          judgeCost += result.costUsd;
          if (data.same_defect && data.explains_impact) yes++;
        }
        if (yes * 2 > votes) { caughtBy = f; method = "llm-judge"; break; }
      } else if (keywordHit(bug, f)) { caughtBy = f; method = "keyword"; break; }
    }
    results.push({ caseId: rec.caseId, ok: rec.ok, caught: Boolean(caughtBy), method, nearFindings: near.length, findings: rec.findings.length, costUsd: rec.usage?.costUsd ?? 0, latencyMs: rec.latencyMs,
      ...(caughtBy ? { by: { title: caughtBy.title, location: caughtBy.location } } : {}) });
    console.error(`${rec.caseId} caught=${Boolean(caughtBy)} near=${near.length}/${rec.findings.length}`);
  }
  writeFileSync(`${run}/judged.json`, JSON.stringify({ judge: router ? `llm:${policyFromEnv().tiers.large[0]!.model} x${votes}` : "keyword", judgeCostUsd: judgeCost, results }, null, 1));
}
