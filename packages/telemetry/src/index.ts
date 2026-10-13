import { context, propagation, trace, SpanStatusCode, type Attributes, type Span } from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { BatchSpanProcessor, InMemorySpanExporter, SimpleSpanProcessor, type SpanExporter, type SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { hashTenant, redact } from "./redact.ts";

export * from "./redact.ts";
export { InMemorySpanExporter };

/** Span processor that redacts attributes before any exporter sees them. */
class RedactingProcessor implements SpanProcessor {
  readonly #inner: SpanProcessor;
  constructor(inner: SpanProcessor) { this.#inner = inner; }
  onStart(span: Parameters<SpanProcessor["onStart"]>[0], ctx: Parameters<SpanProcessor["onStart"]>[1]) { this.#inner.onStart(span, ctx); }
  onEnd(span: Parameters<SpanProcessor["onEnd"]>[0]) {
    const attrs = span.attributes as Record<string, unknown>;
    const clean = redact(attrs) as Record<string, unknown>;
    for (const k of Object.keys(attrs)) attrs[k] = k === "tenant.id" ? hashTenant(String(attrs[k])) : clean[k];
    this.#inner.onEnd(span);
  }
  forceFlush() { return this.#inner.forceFlush(); }
  shutdown() { return this.#inner.shutdown(); }
}

export interface TelemetryOptions {
  serviceName: string;
  /** OTLP/HTTP base, e.g. http://localhost:4318. Unset = no export (spans still created for propagation). */
  otlpEndpoint?: string;
  /** Test hook: export to this exporter synchronously. */
  exporter?: SpanExporter;
}

export function initTelemetry(opts: TelemetryOptions) {
  const processors: SpanProcessor[] = [];
  if (opts.exporter) processors.push(new RedactingProcessor(new SimpleSpanProcessor(opts.exporter)));
  else if (opts.otlpEndpoint) processors.push(new RedactingProcessor(new BatchSpanProcessor(new OTLPTraceExporter({ url: `${opts.otlpEndpoint.replace(/\/$/, "")}/v1/traces` }))));
  const provider = new NodeTracerProvider({ resource: resourceFromAttributes({ "service.name": opts.serviceName }), spanProcessors: processors });
  provider.register({ propagator: new W3CTraceContextPropagator() });
  return { tracer: trace.getTracer(opts.serviceName), shutdown: () => provider.shutdown(), flush: () => provider.forceFlush() };
}

/** Run fn in a span; records exceptions (redacted) and sets status. */
export async function withSpan<T>(name: string, attributes: Attributes, fn: (span: Span) => Promise<T>, parent?: string): Promise<T> {
  const ctx = parent ? extractTraceparent(parent) : context.active();
  return trace.getTracer("review").startActiveSpan(name, { attributes }, ctx, async (span) => {
    try { return await fn(span); } catch (e) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: String(redact((e as Error).message)) });
      throw e;
    } finally { span.end(); }
  });
}

/** Current W3C traceparent, for propagation through queue job data. */
export function currentTraceparent(): string | undefined {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return carrier.traceparent;
}
export const extractTraceparent = (traceparent: string) => propagation.extract(context.active(), { traceparent });

export type LogLevel = "debug" | "info" | "warn" | "error";
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** JSON line logger. Every field passes through redact(); never pass code or prompt text even so. */
export function createLogger(service: string, level: LogLevel = "info", sink: (line: string) => void = (l) => process.stdout.write(l + "\n")) {
  const log = (lvl: LogLevel, msg: string, fields: Record<string, unknown> = {}) => {
    if (ORDER[lvl] < ORDER[level]) return;
    const span = trace.getActiveSpan()?.spanContext();
    const f = { ...fields } as Record<string, unknown>;
    if (typeof f.tenantId === "string") f.tenantId = hashTenant(f.tenantId);
    sink(JSON.stringify({ ts: new Date().toISOString(), level: lvl, service, msg: redact(msg), ...(redact(f) as object), ...(span ? { traceId: span.traceId } : {}) }));
  };
  return {
    debug: (m: string, f?: Record<string, unknown>) => log("debug", m, f),
    info: (m: string, f?: Record<string, unknown>) => log("info", m, f),
    warn: (m: string, f?: Record<string, unknown>) => log("warn", m, f),
    error: (m: string, f?: Record<string, unknown>) => log("error", m, f),
  };
}
export type Logger = ReturnType<typeof createLogger>;
