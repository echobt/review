import { EventEmitter } from "node:events";
import { authenticateApiKey, getReview, pgDatabase, resolveInstallation, withTenant, type Database } from "@review/db";
import { bullmqTransport, connectionFromUrl, consume, createProducer, memoryTransport } from "@review/queue";
import { createLogger, initTelemetry } from "@review/telemetry";
import { loadConfig, memoryObjectStore, readSecret, s3ObjectStore } from "@review/service-common";
import { REVIEW_EVENT, buildApp, type BusEvent } from "./app.ts";

const cfg = loadConfig();
initTelemetry({ serviceName: "api-gateway", ...(cfg.OTEL_EXPORTER_OTLP_ENDPOINT ? { otlpEndpoint: cfg.OTEL_EXPORTER_OTLP_ENDPOINT } : {}) });
const log = createLogger("api-gateway", cfg.LOG_LEVEL);
const memory = cfg.RUNTIME_MODE === "memory";
const transport = memory ? memoryTransport() : bullmqTransport(connectionFromUrl(cfg.REDIS_URL));
const producer = createProducer(transport);
const db: Database | undefined = memory ? undefined : pgDatabase(cfg.DATABASE_URL);
const store = memory ? memoryObjectStore() : s3ObjectStore({ bucket: cfg.S3_BUCKET, region: cfg.S3_REGION, ...(cfg.S3_ENDPOINT ? { endpoint: cfg.S3_ENDPOINT } : {}) });
const DEV_TENANT = "00000000-0000-4000-8000-000000000001";
const devKey = readSecret("DEV_API_KEY");

const events = new EventEmitter();
events.setMaxListeners(0);
const emit = (b: BusEvent) => events.emit(REVIEW_EVENT, b);
consume(transport, "finding.created", async (m) => { emit({ tenantId: m.tenantId, event: { type: "finding", reviewId: m.payload.finding.reviewId, finding: m.payload.finding } }); });
consume(transport, "review.completed", async (m) => {
  const review = db ? await withTenant(db, m.tenantId, (sql) => getReview(sql, m.payload.reviewId)) : undefined;
  if (review) emit({ tenantId: m.tenantId, event: { type: "completed", reviewId: review.id, review } });
});

const app = buildApp({
  enqueue: async (q, tenantId, payload, opts) => { await producer.send(q, tenantId, payload as never, opts?.jobId ? { jobId: opts.jobId } : {}); },
  authenticate: async (key) => {
    if (db) return db.tx((sql) => authenticateApiKey(sql, key)).catch(() => undefined);
    return devKey && key === devKey ? DEV_TENANT : undefined;
  },
  webhookSecret: () => readSecret("GITHUB_WEBHOOK_SECRET"),
  ...(db ? { db, resolveInstallation: (iid: string) => db.tx((sql) => resolveInstallation(sql, "github", iid)) } : {}),
  store, events,
  ready: async () => (await transport.ping()) && (!db || (await db.tx((sql) => sql.query("SELECT 1")).then(() => true, () => false))),
});
await app.listen({ port: cfg.PORT, host: "0.0.0.0" });
log.info("api-gateway listening", { port: cfg.PORT, mode: cfg.RUNTIME_MODE });
