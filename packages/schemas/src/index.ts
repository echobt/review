import { z } from "zod";
import * as core from "@review/core";

export * from "@review/core";

/** JSON Schema (draft 2020-12) for any zod schema; `io: "input"` so defaults stay optional for producers. */
export const toJsonSchema = (schema: z.ZodType): Record<string, unknown> =>
  z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;

/** Draft finding produced by an agent: the platform assigns id/reviewId/source after validation. */
export const FindingDraft = core.Finding.omit({ id: true, reviewId: true, source: true });
export type FindingDraft = z.infer<typeof FindingDraft>;
export const FindingDraftList = z.object({ findings: z.array(FindingDraft).max(50) });
export type FindingDraftList = z.infer<typeof FindingDraftList>;

/** Named JSON Schemas for API docs / non-TS SDK generation. */
export function jsonSchemas(): Record<string, Record<string, unknown>> {
  return {
    Finding: toJsonSchema(core.Finding), Review: toJsonSchema(core.Review), CreateReviewRequest: toJsonSchema(core.CreateReviewRequest),
    CreateIndexRequest: toJsonSchema(core.CreateIndexRequest), CreateTestGenRequest: toJsonSchema(core.CreateTestGenRequest),
    ScoreRequest: toJsonSchema(core.ScoreRequest), ScoreReport: toJsonSchema(core.ScoreReport), TenantConfig: toJsonSchema(core.TenantConfig),
    CreateFeedbackRequest: toJsonSchema(core.CreateFeedbackRequest), FindingDraftList: toJsonSchema(FindingDraftList),
  };
}
