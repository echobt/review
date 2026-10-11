import { expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { MockProvider, toolResult } from "@review/models";
import { MockSandboxDriver } from "../src/sandbox.ts";
import { Sarif, SEMGREP_OUT, parseSarif, runSemgrep, toSarif, triage } from "../src/semgrep.ts";
import { TENANT, mockRouter } from "./helpers.ts";

const fixture = readFileSync(new URL("./fixtures/semgrep.sarif", import.meta.url));

test("runSemgrep runs semgrep in the sandbox and parses SARIF", async () => {
  const d = new MockSandboxDriver(() => ({ exitCode: 0, files: { [SEMGREP_OUT]: fixture } }));
  const results = await runSemgrep(d, { rules: "p/default", files: { "src/app.js": "debugger;" } });
  expect(d.calls[0]!.command).toEqual(["semgrep", "scan", "--config", "p/default", "--sarif", "--metrics=off", "--disable-version-check", "--quiet", "-o", "/out/results.sarif"]);
  expect(d.calls[0]!.limits.network).toBe("none");
  expect(results.map((r) => [r.path, r.startLine, r.endLine, r.severity, r.cwe])).toEqual([
    ["src/routes/users.js", 14, 14, "critical", ["CWE-89"]],
    ["src/files.js", 7, 9, "medium", ["CWE-22"]],
    ["src/app.js", 3, 3, "low", []],
  ]);
  await expect(runSemgrep(new MockSandboxDriver(() => ({ exitCode: 2 })), { rules: "r", files: {} })).rejects.toThrow(/semgrep failed/);
});

test("triage keeps confident TPs as hybrid findings, drops FPs", async () => {
  const results = parseSarif(fixture.toString());
  const provider = new MockProvider("mock", [toolResult("triage", { verdicts: [
    { index: 0, verdict: "true_positive", confidence: 0.9, rationale: "req.query.id concatenated" },
    { index: 1, verdict: "false_positive", confidence: 0.8, rationale: "path is constant" },
    { index: 2, verdict: "true_positive", confidence: 0.3, rationale: "maybe" },
  ] })]);
  const findings = await triage(mockRouter(provider), results, { tenantId: TENANT, reviewId: "r1" });
  expect(findings).toHaveLength(1);
  expect(findings[0]).toMatchObject({ source: "hybrid", severity: "critical", cwe: ["CWE-89"], category: "security", confidence: 0.9, location: { path: "src/routes/users.js", startLine: 14 } });
  expect(provider.requests[0]!.toolChoice).toBe("triage");
});

test("toSarif round-trips through the SARIF schema", async () => {
  const provider = new MockProvider("mock", [toolResult("triage", { verdicts: [0, 1, 2].map((index) => ({ index, verdict: "true_positive", confidence: 0.9, rationale: "x" })) })]);
  const findings = await triage(mockRouter(provider), parseSarif(fixture.toString()), { tenantId: TENANT, reviewId: "r1" });
  const sarif = toSarif([...findings, findings[0]!]);
  const reparsed = Sarif.parse(JSON.parse(JSON.stringify(sarif)));
  expect(reparsed.runs[0]!.tool.driver.name).toBe("review-platform");
  expect(reparsed.runs[0]!.tool.driver.rules).toHaveLength(3);
  expect(reparsed.runs[0]!.results).toHaveLength(4);
  expect(reparsed.runs[0]!.results[0]).toMatchObject({ level: "error", fingerprints: { "review/v1": expect.any(String) } });
  expect(parseSarif(sarif).map((r) => [r.path, r.startLine, r.cwe])).toEqual(findings.concat(findings[0]!).map((f) => [f.location.path, f.location.startLine, f.cwe]));
});
