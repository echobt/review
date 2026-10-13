import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { bullmqTransport, connectionFromUrl, consume, memoryTransport, type Handler, type QueueTransport } from "@review/queue";
import { createLogger, initTelemetry, withSpan, type Logger } from "@review/telemetry";
import type { QueueName } from "@review/core";
import { loadConfig, type ServiceConfig } from "./config.ts";

export type HealthCheck = () => Promise<boolean>;

/** Minimal health server for workers: GET /healthz (liveness) and /readyz (dependency checks). */
export async function startHealthServer(name: string, port: number, checks: Record<string, HealthCheck> = {}): Promise<{ server: Server; port: number }> {
  const server = createServer(async (req, res) => {
    if (req.url === "/healthz") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ ok: true, service: name })); }
    if (req.url === "/readyz") {
      const results = Object.fromEntries(await Promise.all(Object.entries(checks).map(async ([k, f]) => [k, await f().catch(() => false)] as const)));
      const ok = Object.values(results).every(Boolean);
      res.writeHead(ok ? 200 : 503, { "content-type": "application/json" });
      return res.end(JSON.stringify({ ok, service: name, checks: results }));
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(port, "0.0.0.0", r));
  return { server, port: (server.address() as AddressInfo).port };
}

export interface WorkerContext { cfg: ServiceConfig; log: Logger; transport: QueueTransport }

/**
 * Standard worker bootstrap: config, OTel, logger, queue transport, typed consumer wrapped in a span
 * continuing the producer's traceparent, health server, graceful shutdown.
 */
export async function runWorker<Q extends QueueName>(name: string, queue: Q, makeHandler: (ctx: WorkerContext) => Promise<Handler<Q>> | Handler<Q>, env = process.env) {
  const cfg = loadConfig(env);
  const telemetry = initTelemetry({ serviceName: name, ...(cfg.OTEL_EXPORTER_OTLP_ENDPOINT ? { otlpEndpoint: cfg.OTEL_EXPORTER_OTLP_ENDPOINT } : {}) });
  const log = createLogger(name, cfg.LOG_LEVEL);
  const transport = cfg.RUNTIME_MODE === "memory" ? memoryTransport() : bullmqTransport(connectionFromUrl(cfg.REDIS_URL));
  const handler = await makeHandler({ cfg, log, transport });
  const sub = consume(transport, queue, (msg) => withSpan(`${queue} process`, { "tenant.id": msg.tenantId, "messaging.message.id": msg.messageId }, async () => {
    await handler(msg);
    log.info("job done", { queue, messageId: msg.messageId, tenantId: msg.tenantId });
  }, msg.traceparent));
  const health = await startHealthServer(name, cfg.HEALTH_PORT ?? cfg.PORT, { queue: () => transport.ping() });
  log.info("worker started", { queue, healthPort: health.port, mode: cfg.RUNTIME_MODE });
  const stop = async () => { await sub.close(); await transport.close(); health.server.close(); await telemetry.shutdown(); };
  process.once("SIGTERM", () => void stop().then(() => process.exit(0)));
  process.once("SIGINT", () => void stop().then(() => process.exit(0)));
  return { stop, port: health.port, transport };
}
