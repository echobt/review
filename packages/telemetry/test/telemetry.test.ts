import { expect, test } from "vitest";
import { InMemorySpanExporter, REDACTED, createLogger, currentTraceparent, hashTenant, initTelemetry, redact, withSpan } from "../src/index.ts";

test("redact drops code/prompt/secret keys and scrubs token patterns", () => {
  const out = redact({
    reviewId: "r1", prompt: "You are a reviewer", diff: "+ const x = 1", apiKey: "abc", nested: { authorization: "Bearer x", ok: 1, github_token: "t" },
    note: "called with sk-or-v1-0123456789abcdefABCDEF and ghp_abcdefghijklmnopqrstuvwxyz0123",
  }) as Record<string, any>;
  expect(out.reviewId).toBe("r1");
  expect([out.prompt, out.diff, out.apiKey, out.nested.authorization, out.nested.github_token]).toEqual(Array(5).fill(REDACTED));
  expect(out.nested.ok).toBe(1);
  expect(out.note).not.toMatch(/sk-or|ghp_/);
});

test("logger output never contains secrets or code and hashes tenant id", () => {
  const lines: string[] = [];
  const log = createLogger("svc", "info", (l) => lines.push(l));
  log.info("model call Bearer abcdefghijkl", { tenantId: "tenant-123", content: "SELECT * FROM users", tokensIn: 10 });
  log.debug("hidden");
  expect(lines).toHaveLength(1);
  const rec = JSON.parse(lines[0]!);
  expect(lines[0]).not.toContain("SELECT * FROM users");
  expect(lines[0]).not.toContain("abcdefghijkl");
  expect(rec.tenantId).toBe(hashTenant("tenant-123"));
  expect(rec.tokensIn).toBe(10);
});

test("spans export with redacted attributes, hashed tenant, and traceparent propagates", async () => {
  const exporter = new InMemorySpanExporter();
  const t = initTelemetry({ serviceName: "test", exporter });
  let tp: string | undefined;
  await withSpan("parent", { "tenant.id": "tenant-1", prompt: "secret prompt", "tokens.in": 5 }, async () => { tp = currentTraceparent(); });
  expect(tp).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/);
  await withSpan("child", {}, async () => undefined, tp);
  await t.flush();
  const [p, c] = exporter.getFinishedSpans();
  expect(p!.attributes.prompt).toBe(REDACTED);
  expect(p!.attributes["tenant.id"]).toBe(hashTenant("tenant-1"));
  expect(p!.attributes["tokens.in"]).toBe(5);
  expect(c!.spanContext().traceId).toBe(p!.spanContext().traceId);
  await t.shutdown();
});
