import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMessage } from "@review/core";
import { handle } from "../src/handler.ts";

test("handler receives a validated, tenant-scoped message", async () => {
  const msg = parseMessage("review.requested", { messageId: "7f1d2c9e-8a8b-4c4e-9d55-1d0f3b9a2c11", tenantId: "t9", createdAt: "2026-10-11T00:00:00Z", payload: { reviewId: "r", repositoryId: "repo" } });
  assert.deepEqual(await handle(msg), { status: "skeleton", tenantId: "t9" });
});
