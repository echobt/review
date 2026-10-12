import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { bestComment, terms } from "../extract.ts";
import { keywordHit, locationHit } from "../judge.ts";
import { summarize } from "../report.ts";

const ds = JSON.parse(readFileSync(new URL("../../../docs/scoring/datasets/greptile-50/dataset.json", import.meta.url), "utf8"));
const table = JSON.parse(readFileSync(new URL("../cases.json", import.meta.url), "utf8"));

test("dataset: 50 cases, 10 per repo, pinned SHAs, published Greptile total 41/50 and 8/10 on Sentry", () => {
  expect(ds.cases).toHaveLength(50);
  for (const r of ["sentry", "calcom", "grafana", "keycloak", "discourse"]) expect(ds.cases.filter((c: { id: string }) => c.id.startsWith(r + "-"))).toHaveLength(10);
  for (const c of ds.cases) { expect(c.baseSha).toMatch(/^[0-9a-f]{40}$/); expect(c.headSha).toMatch(/^[0-9a-f]{40}$/); }
  expect(ds.cases.filter((c: { published: { greptile: boolean } }) => c.published.greptile)).toHaveLength(41);
  expect(ds.cases.filter((c: { id: string; published: { greptile: boolean } }) => c.id.startsWith("sentry") && c.published.greptile)).toHaveLength(8);
  expect(ds.cases.filter((c: { id: string; labelSource: string }) => c.id.startsWith("sentry")).every((c: { labelSource: string }) => c.labelSource === "human")).toBe(true);
  expect(table.cases).toHaveLength(50);
});

test("label auto-pick prefers the comment overlapping the bug description", () => {
  expect(terms("Inconsistent metric tagging with 'shard' and 'shards'")).toContain("shards");
  const best = bestComment("sample_rate = 0.0 is falsy", [
    { tool: "greptile", path: "a.py", line: 1, body: "unused import" },
    { tool: "greptile", path: "f.py", line: 353, body: "client_sample_rate 0.0 is falsy here" },
  ]);
  expect(best?.line).toBe(353);
});

test("judge location rule mirrors the published rule: +/-3 lines, <= 10-line span, acceptAlso sites", () => {
  const bug = { description: "shard vs shards", location: { path: "f.py", startLine: 199, endLine: 199 }, acceptAlso: [{ path: "f.py", startLine: 185, endLine: 185 }], keyTerms: ["shards"] };
  const f = (s: number, e = s, path = "f.py") => ({ title: "Tag key 'shards' differs", body: "", location: { path, startLine: s, endLine: e } });
  expect(locationHit(bug, f(202))).toBe(true);
  expect(locationHit(bug, f(203))).toBe(false);
  expect(locationHit(bug, f(186))).toBe(true);
  expect(locationHit(bug, f(190, 205))).toBe(false); // 16-line span
  expect(locationHit(bug, f(199, 199, "g.py"))).toBe(false);
  expect(keywordHit(bug, f(199))).toBe(true);
});

test("report: catch rate per repo/severity, cost and latency medians", () => {
  const rep = summarize([
    { caseId: "sentry-03", caught: true, ok: true, costUsd: 0.2, latencyMs: 10_000, findings: 3 },
    { caseId: "sentry-02", caught: false, ok: true, costUsd: 0.4, latencyMs: 30_000, findings: 5 },
  ], ds);
  expect(rep).toMatchObject({ caught: 1, of: 2, perRepo: { sentry: { caught: 1, of: 2, greptile: 1 } }, perSeverity: { low: { caught: 1, of: 1 } }, costUsd: { medianPerPr: expect.closeTo(0.3, 5) }, latencyS: { median: 20 } });
});
