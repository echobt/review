import { loadConfig, connectionFromUrl, makeProducer } from "@review/service-common";
import { QUEUE_NAMES, type QueueName } from "@review/core";
import { buildApp } from "./app.ts";

const cfg = loadConfig();
const conn = connectionFromUrl(cfg.REDIS_URL);
const producers = Object.fromEntries(QUEUE_NAMES.map((q) => [q, makeProducer(q, conn)])) as { [Q in QueueName]: ReturnType<typeof makeProducer<Q>> };
const app = buildApp({
  enqueue: async (q, tenantId, payload) => { await producers[q].send(tenantId, payload as never); },
  // Skeleton: dev-only auth. Real impl hashes the key and looks it up in api_keys (ADR-0007).
  authenticate: async (key) => (process.env.DEV_API_KEY && key === process.env.DEV_API_KEY ? "dev-tenant" : undefined),
});
await app.listen({ port: cfg.PORT, host: "0.0.0.0" });
console.log(`api-gateway listening on :${cfg.PORT}`);
