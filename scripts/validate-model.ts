// Live end-to-end model-routing check against OpenRouter (docs/VALIDATION.md).
// Usage: node scripts/validate-model.ts   (exit 0 = PASS, 1 = FAIL, 2 = SKIPPED: no key). Key from OPENROUTER_API_KEY or OPENROUTER_API_KEY_FILE; never printed.
import { z } from "zod";
import { Finding } from "@review/core";
import { MemoryBudgetLedger, ModelRouter, RoutingPolicy, defaultPolicy, providersFromEnv } from "@review/models";

const env = process.env;
if (!env.OPENROUTER_API_KEY && !env.OPENROUTER_API_KEY_FILE) { console.log("SKIPPED: set OPENROUTER_API_KEY or OPENROUTER_API_KEY_FILE"); process.exit(2); }

const model = env.VALIDATE_MODEL ?? "deepseek/deepseek-v4.1-flash";
const target = { provider: "openrouter", model, inputUsdPerMTok: 0.1, outputUsdPerMTok: 0.4 };
const policy = RoutingPolicy.parse({ ...defaultPolicy, tiers: { small: [target], medium: [target], large: [target] }, downgrade: false });
const router = new ModelRouter(policy, { providers: providersFromEnv(env), budget: new MemoryBudgetLedger({ prUsd: 0.05, tenantMonthlyUsd: 0.05 }) });

const ReportFindings = z.object({ findings: z.array(Finding.omit({ id: true, reviewId: true, source: true })).min(1) });
const diff = `--- a/src/db.ts
+++ b/src/db.ts
@@ -10,3 +10,4 @@
-  return db.query("SELECT * FROM users WHERE id = $1", [req.params.id]);
+  return db.query("SELECT * FROM users WHERE id = '" + req.params.id + "'");
 }`;

const t0 = Date.now();
try {
  const { data, result } = await router.json("small", [
    { role: "system", content: "You are a code reviewer. Call report_findings exactly once." },
    { role: "user", content: `Review this diff:\n${diff}` },
  ], ReportFindings, { scope: { tenantId: "validation", reviewId: "validation" }, toolName: "report_findings", maxTokens: 800 });
  const sec = data.findings.some((f) => f.category === "security" && f.location.path.includes("db.ts"));
  console.log(JSON.stringify({ model: result.model, provider: result.provider, latencyMs: Date.now() - t0, inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens, costUsd: result.costUsd, schemaValid: true, securityFindingOnDbTs: sec }, null, 2));
  console.log(sec ? "PASS" : "FAIL");
  process.exit(sec ? 0 : 1);
} catch (e) {
  console.log(JSON.stringify({ model, latencyMs: Date.now() - t0, error: (e as Error).message }, null, 2));
  console.log("FAIL");
  process.exit(1);
}
