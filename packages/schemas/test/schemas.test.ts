import { expect, test } from "vitest";
import { FindingDraftList, jsonSchemas, toJsonSchema } from "../src/index.ts";

test("FindingDraftList JSON Schema is an object schema with required findings array", () => {
  const s = toJsonSchema(FindingDraftList) as { type: string; required: string[]; properties: { findings: { type: string } } };
  expect(s.type).toBe("object");
  expect(s.required).toContain("findings");
  expect(s.properties.findings.type).toBe("array");
});

test("every exported schema converts", () => {
  const all = jsonSchemas();
  expect(Object.keys(all).length).toBeGreaterThanOrEqual(10);
  for (const [k, v] of Object.entries(all)) expect([k, typeof v]).toEqual([k, "object"]);
});
