import { test, expect } from "vitest";
import { Finding, TenantConfig, parseMessage, type Severity } from "@review/core";
import { MemoryBudgetLedger, MockProvider, ModelRouter, RoutingPolicy, toolResult, type ChatRequest } from "@review/models";
import { createTestDatabase } from "@review/db/testing";
import { addFeedback, createReview, getReview, withTenant } from "@review/db";
import { createProducer, memoryTransport, tenantKey } from "@review/queue";
import { memoryObjectStore } from "@review/service-common";
import { runAgent } from "@review/agent-runner";
import { RecordingGitHubClient, filterFiles, fingerprint, handle, mergeFindings, parseDiff, planReview } from "../src/index.ts";

const f = (id: string, severity: Severity, confidence: number, o: { path?: string; line?: number; title?: string } = {}): Finding => Finding.parse({
  id, reviewId: "r", category: "bug", severity, confidence, title: o.title ?? `t ${id}`, body: "b", source: "llm",
  location: { path: o.path ?? "a.ts", startLine: o.line ?? 10, endLine: o.line ?? 10 },
});

test("confidence threshold drops low findings; cap keeps top-N by severity x confidence deterministically", () => {
  const all = [f("1", "low", 0.9, { line: 1 }), f("2", "critical", 0.7, { line: 20 }), f("3", "high", 0.95, { line: 40 }),
    f("4", "critical", 0.5, { line: 60 }), f("5", "medium", 0.8, { line: 80 }), f("6", "high", 0.95, { line: 100, path: "b.ts" })];
  const out = mergeFindings(all, { config: { confidenceThreshold: 0.6, maxComments: 3 } });
  expect(out.map((m) => m.finding.id)).toEqual(["2", "3", "6"]);
  expect(mergeFindings([...all].reverse(), { config: { confidenceThreshold: 0.6, maxComments: 3 } }).map((m) => m.finding.id)).toEqual(["2", "3", "6"]);
});

test("dedup by fingerprint keeps highest confidence and merges locations", () => {
  const a = f("a", "high", 0.7, { line: 11, title: "Null deref!" });
  const b = f("b", "high", 0.9, { line: 12, title: "null  DEREF" });
  expect(fingerprint(a)).toBe(fingerprint(b));
  const out = mergeFindings([a, b, f("c", "high", 0.9, { line: 30, title: "null deref" })], { config: { confidenceThreshold: 0, maxComments: 10 } });
  expect(out).toHaveLength(2);
  const m = out.find((x) => x.finding.id === "b")!;
  expect(m.finding.related).toEqual([{ path: "a.ts", startLine: 11, endLine: 11 }]);
});

const DIFF = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,2 +1,3 @@
 const x = 1;
+const y = x.foo.bar;
 export {};
diff --git a/README.md b/README.md
--- a/README.md
+++ b/README.md
@@ -1 +1,2 @@
 # t
+more
diff --git a/node_modules/z/i.js b/node_modules/z/i.js
--- a/node_modules/z/i.js
+++ b/node_modules/z/i.js
@@ -1 +1 @@
-a
+b
`;

test("path filters + planning", () => {
  const files = parseDiff(DIFF);
  expect(files.map((x) => x.path)).toEqual(["src/a.ts", "README.md", "node_modules/z/i.js"]);
  expect(files[0]!.hunks[0]).toMatchObject({ newStart: 1, newLines: 3 });
  const config = TenantConfig.parse({ pathFilters: { include: ["src/**", "*.md"], exclude: ["**/node_modules/**"] },
    rules: [{ id: "r1", name: "no-any", description: "", paths: ["src/**/*.ts"], severity: "low", kind: "natural-language", body: "Avoid any" }] });
  const kept = filterFiles(files, config.pathFilters);
  expect(kept.map((x) => x.path)).toEqual(["src/a.ts", "README.md"]);
  const units = planReview(kept, config);
  expect(units.map((u) => `${u.kind}:${u.files.map((x) => x.path).join(",")}`)).toEqual(["bug-hunter:src/a.ts", "security:src/a.ts", "bug-hunter:README.md", "cross-file:src/a.ts,README.md"]);
  expect(units[0]!.rules).toEqual([{ name: "no-any", body: "Avoid any" }]);
  expect(units[2]!.rules).toEqual([]);
});

const target = { provider: "mock", model: "m", inputUsdPerMTok: 1, outputUsdPerMTok: 1 };
const policy = RoutingPolicy.parse({ tiers: { small: [target], medium: [target], large: [target] }, embed: [{ ...target, dimensions: 8 }], retry: { attempts: 1 } });
const draft = { category: "bug", severity: "high", title: "Null deref on x.foo", body: "x.foo may be undefined", location: { path: "src/a.ts", startLine: 2, endLine: 2 }, confidence: 0.9, suggestion: "const y = x.foo?.bar;" };
const script = (req: ChatRequest) => req.toolChoice === "report_summary"
  ? toolResult("report_summary", { summary: "One risky deref." })
  : toolResult("report_findings", { findings: req.messages[0]!.content.includes("security agent") ? [] : [draft] });

async function setup() {
  const { db, newTenant } = await createTestDatabase();
  const tenantId = await newTenant();
  const provider = new MockProvider("mock", [script]);
  const router = new ModelRouter(policy, { providers: [provider], budget: new MemoryBudgetLedger({ prUsd: 1, tenantMonthlyUsd: 10 }), sleep: async () => {} });
  const transport = memoryTransport();
  const store = memoryObjectStore();
  const github = new RecordingGitHubClient();
  const deps = { db, store, github, producer: createProducer(transport), executor: (req: Parameters<typeof runAgent>[1]) => runAgent({ router, db }, req) };
  const msg = (reviewId: string, diffObjectKey: string) => parseMessage("review.requested", { messageId: crypto.randomUUID(), tenantId, createdAt: "2026-10-11T00:00:00Z",
    payload: { reviewId, repositoryId: "repo", diffObjectKey, pullRequest: { provider: "github", owner: "o", repo: "r", number: 7, headSha: "abcdef1" } } });
  return { db, tenantId, store, github, transport, deps, msg };
}

test("end-to-end: review.requested -> findings persisted, GitHub payloads, events; dismissed feedback suppresses next run", async () => {
  const { db, tenantId, store, github, transport, deps, msg } = await setup();
  const key = tenantKey(tenantId, "diffs", "rev1.patch");
  await store.put(key, Buffer.from(DIFF));
  await withTenant(db, tenantId, (sql) => createReview(sql, tenantId, { id: "rev1", repositoryId: "repo", diffObjectKey: key }));
  const out = await handle(deps, msg("rev1", key));

  expect(out.findings).toHaveLength(1);
  const review = await withTenant(db, tenantId, (sql) => getReview(sql, "rev1"));
  expect(review).toMatchObject({ status: "completed", summary: "One risky deref." });
  expect(review!.findings).toHaveLength(1);
  expect(review!.findings[0]!.related).toEqual([]);

  expect(github.reviews).toHaveLength(1);
  expect(github.reviews[0]!.review.body).toBe("One risky deref.");
  expect(github.reviews[0]!.review.comments).toEqual([{ path: "src/a.ts", line: 2, side: "RIGHT", body: expect.stringContaining("```suggestion\nconst y = x.foo?.bar;\n```") }]);
  expect(github.checks[0]!.check).toMatchObject({ headSha: "abcdef1", conclusion: "failure", annotations: [{ path: "src/a.ts", annotation_level: "failure" }] });

  expect(transport.sent.map((s) => s.queue)).toEqual(["finding.created", "review.completed"]);
  expect((transport.sent[1]!.msg as { payload: { findingCount: number } }).payload.findingCount).toBe(1);

  await withTenant(db, tenantId, (sql) => addFeedback(sql, tenantId, out.findings[0]!.id, { verdict: "dismissed" }));
  await withTenant(db, tenantId, (sql) => createReview(sql, tenantId, { id: "rev2", repositoryId: "repo", diffObjectKey: key }));
  const again = await handle(deps, msg("rev2", key));
  expect(again.findings).toEqual([]);
  expect(github.checks[1]!.check.conclusion).toBe("success");
});
