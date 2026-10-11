import { expect, test } from "vitest";
import { consume, createProducer, memoryTransport, physicalQueue, tenantKey } from "../src/index.ts";

test("producer validates payloads, consumer receives parsed tenant-scoped messages", async () => {
  const t = memoryTransport();
  const got: string[] = [];
  consume(t, "review.requested", async (m) => { got.push(`${m.tenantId}:${m.payload.reviewId}`); });
  await createProducer(t).send("review.requested", "t1", { reviewId: "r1", repositoryId: "repo" }, { traceparent: "00-abc-def-01" });
  await t.drain();
  expect(got).toEqual(["t1:r1"]);
  expect((t.sent[0]!.msg as { traceparent: string }).traceparent).toBe("00-abc-def-01");
});

test("invalid payload is rejected before enqueue", async () => {
  const t = memoryTransport();
  await expect(createProducer(t).send("sandbox.run", "t1", { runId: "r", image: "i", command: [], workspaceObjectKey: "k", timeoutSec: 5, network: "none" })).rejects.toThrow();
  expect(t.sent).toHaveLength(0);
});

test("duplicate jobId is idempotent; malformed job data fails in consumer", async () => {
  const t = memoryTransport();
  let n = 0;
  consume(t, "score.requested", async () => { n++; });
  const p = createProducer(t);
  await p.send("score.requested", "t1", { reviewId: "r", datasetCaseId: "c", rubricVersion: "1.0.0" }, { jobId: "same" });
  await p.send("score.requested", "t1", { reviewId: "r", datasetCaseId: "c", rubricVersion: "1.0.0" }, { jobId: "same" });
  await t.add("score.requested", { bogus: true }, { jobId: "bad" });
  await t.drain();
  expect(n).toBe(1);
  expect(t.failures).toHaveLength(1);
});

test("events use evt.* queues; tenant keys are prefixed and traversal-safe", () => {
  expect(physicalQueue("finding.created")).toBe("evt.finding.created");
  expect(physicalQueue("agent.task")).toBe("agent.task");
  expect(tenantKey("t1", "blobs", "abc")).toBe("tenants/t1/blobs/abc");
  expect(() => tenantKey("t1", "../t2")).toThrow();
});
