// End-to-end model-routing check against OpenRouter. Requires OPENROUTER_API_KEY or OPENROUTER_API_KEY_FILE.
// Usage: node --experimental-strip-types scripts/validate-model.ts   (exit 0 = PASS, 1 = FAIL, 2 = SKIPPED: no key)
// The key is read from env/file and never printed.
import { z } from "zod";
import { Finding } from "@review/core";
import { ModelRouter, defaultPolicy, readSecret } from "@review/service-common";

const key = readSecret("OPENROUTER_API_KEY");
if (!key) { console.log("SKIPPED: set OPENROUTER_API_KEY or OPENROUTER_API_KEY_FILE"); process.exit(2); }

const model = process.env.VALIDATE_MODEL ?? "deepseek/deepseek-v4.1-flash";
const policy = { ...defaultPolicy, tiers: { ...defaultPolicy.tiers, cheap: [{ provider: "openrouter", model, inputUsdPerMTok: 0, outputUsdPerMTok: 0 }] } };
const router = new ModelRouter(policy, 0.05, { ...process.env, OPENROUTER_API_KEY: key });

const ReportFindings = z.object({ findings: z.array(Finding.omit({ id: true, reviewId: true })).min(1) });
const tool = {
  name: "report_findings",
  description: "Report code review findings for the diff.",
  parameters: {
    type: "object", required: ["findings"],
    properties: { findings: { type: "array", minItems: 1, items: { type: "object",
      required: ["category", "severity", "title", "body", "location", "confidence", "source"],
      properties: {
        category: { enum: ["bug", "security", "performance", "maintainability", "style", "test", "docs"] },
        severity: { enum: ["info", "low", "medium", "high", "critical"] },
        title: { type: "string" }, body: { type: "string" },
        location: { type: "object", required: ["path", "startLine", "endLine"], properties: { path: { type: "string" }, startLine: { type: "integer" }, endLine: { type: "integer" } } },
        confidence: { type: "number", minimum: 0, maximum: 1 },
        source: { const: "llm" },
        cwe: { type: "array", items: { type: "string" } },
      } } } },
  },
};
const diff = `--- a/src/db.ts
+++ b/src/db.ts
@@ -10,3 +10,4 @@
 export async function getUser(db, req) {
-  return db.query("SELECT * FROM users WHERE id = $1", [req.params.id]);
+  return db.query("SELECT * FROM users WHERE id = '" + req.params.id + "'");
 }`;

const t0 = Date.now();
const r = await router.complete("cheap", [
  { role: "system", content: "You are a code reviewer. Call report_findings exactly once." },
  { role: "user", content: `Review this diff:\n${diff}` },
], { tool, maxTokens: 800 });
const parsed = ReportFindings.safeParse(JSON.parse(r.toolArguments ?? "null"));
const sec = parsed.success && parsed.data.findings.some((f) => f.category === "security" && f.location.path.includes("db.ts"));
console.log(JSON.stringify({ model: r.model, provider: r.provider, latencyMs: Date.now() - t0, inputTokens: r.inputTokens, outputTokens: r.outputTokens, costUsd: r.costUsd,
  schemaValid: parsed.success, securityFindingOnDbTs: sec, error: parsed.success ? undefined : parsed.error.message }, null, 2));
if (!parsed.success || !sec) { console.log("FAIL"); process.exit(1); }
console.log("PASS");
