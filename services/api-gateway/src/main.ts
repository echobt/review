import { bullmqTransport, connectionFromUrl, createProducer, memoryTransport } from "@review/queue";
import { createLogger, initTelemetry } from "@review/telemetry";
import { loadConfig } from "@review/service-common";
import { buildApp } from "./app.ts";

const cfg = loadConfig();
initTelemetry({ serviceName: "api-gateway", ...(cfg.OTEL_EXPORTER_OTLP_ENDPOINT ? { otlpEndpoint: cfg.OTEL_EXPORTER_OTLP_ENDPOINT } : {}) });
const log = createLogger("api-gateway", cfg.LOG_LEVEL);
const transport = cfg.RUNTIME_MODE === "memory" ? memoryTransport() : bullmqTransport(connectionFromUrl(cfg.REDIS_URL));
const producer = createProducer(transport);
const app = buildApp({
  enqueue: async (q, tenantId, payload) => { await producer.send(q, tenantId, payload as never); },
  // Dev-only auth until the DB-backed store is wired (lane: review).
  authenticate: async (key) => (process.env.DEV_API_KEY && key === process.env.DEV_API_KEY ? "dev-tenant" : undefined),
});
await app.listen({ port: cfg.PORT, host: "0.0.0.0" });
log.info("api-gateway listening", { port: cfg.PORT });
