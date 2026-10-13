import { randomUUID } from "node:crypto";
import { Queue, Worker, type ConnectionOptions } from "bullmq";
import { EVENT_QUEUES, parseMessage, type Message, type QueueName } from "@review/core";

/** Physical queue name: jobs keep their name, events fan out on evt.* (ADR 0002). BullMQ forbids ':'. */
export const physicalQueue = (q: QueueName): string => ((EVENT_QUEUES as readonly string[]).includes(q) ? `evt.${q}` : q);

export interface SendOptions {
  traceparent?: string;
  /** Deterministic idempotency key (e.g. reviewId + headSha). Defaults to the messageId. */
  jobId?: string;
  delayMs?: number;
}

export type Handler<Q extends QueueName> = (msg: Message<Q>) => Promise<void>;

/** Transport port. Payload validation happens above it, so transports only move already-valid envelopes. */
export interface QueueTransport {
  add(queue: QueueName, msg: unknown, opts: { jobId: string; delayMs?: number }): Promise<void>;
  consume(queue: QueueName, handler: (data: unknown) => Promise<void>, concurrency: number): { close(): Promise<void> };
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

export function connectionFromUrl(url: string): ConnectionOptions {
  const u = new URL(url);
  return {
    host: u.hostname, port: Number(u.port || 6379),
    ...(u.username ? { username: decodeURIComponent(u.username) } : {}),
    ...(u.password ? { password: decodeURIComponent(u.password) } : {}),
    ...(u.protocol === "rediss:" ? { tls: {} } : {}),
    maxRetriesPerRequest: null,
  };
}

export function bullmqTransport(connection: ConnectionOptions, prefix = "review"): QueueTransport {
  const queues = new Map<string, Queue>();
  const workers: Worker[] = [];
  const get = (q: QueueName) => {
    const name = physicalQueue(q);
    let queue = queues.get(name);
    if (!queue) { queue = new Queue(name, { connection, prefix }); queues.set(name, queue); }
    return queue;
  };
  return {
    async add(q, msg, opts) {
      await get(q).add(q, msg, {
        jobId: assertJobId(opts.jobId), attempts: 5, backoff: { type: "exponential", delay: 2000 },
        removeOnComplete: 1000, removeOnFail: 5000, ...(opts.delayMs ? { delay: opts.delayMs } : {}),
      });
    },
    consume(q, handler, concurrency) {
      const w = new Worker(physicalQueue(q), async (job) => handler(job.data), { connection, prefix, concurrency });
      workers.push(w);
      return { close: () => w.close() };
    },
    async ping() {
      try { const c = (await get("index.requested").client) as unknown as { ping(): Promise<string> }; return (await c.ping()) === "PONG"; } catch { return false; }
    },
    async close() { await Promise.all([...workers.map((w) => w.close()), ...[...queues.values()].map((q) => q.close())]); },
  };
}

/**
 * In-process transport for tests and single-process dev. Delivery is async (microtask) and handler errors
 * are recorded in `failures`, mirroring BullMQ's failed set. `drain()` resolves when all queues are idle.
 */
export function memoryTransport() {
  const handlers = new Map<QueueName, (d: unknown) => Promise<void>>();
  const pending = new Map<QueueName, unknown[]>();
  const seen = new Set<string>();
  const sent: { queue: QueueName; msg: unknown }[] = [];
  const failures: { queue: QueueName; error: Error }[] = [];
  let inflight = 0;
  let idle: (() => void)[] = [];
  const settle = () => { if (inflight === 0) { const w = idle; idle = []; w.forEach((r) => r()); } };
  const deliver = (q: QueueName, msg: unknown) => {
    const h = handlers.get(q);
    if (!h) { pending.set(q, [...(pending.get(q) ?? []), msg]); return; }
    inflight++;
    queueMicrotask(() => {
      h(msg).catch((e: unknown) => failures.push({ queue: q, error: e as Error })).finally(() => { inflight--; settle(); });
    });
  };
  const t: QueueTransport & { sent: typeof sent; failures: typeof failures; drain(): Promise<void> } = {
    sent, failures,
    async add(q, msg, opts) {
      assertJobId(opts.jobId);
      if (seen.has(`${q}/${opts.jobId}`)) return; // BullMQ semantics: duplicate jobId is a no-op
      seen.add(`${q}/${opts.jobId}`);
      sent.push({ queue: q, msg });
      deliver(q, msg);
    },
    consume(q, handler) {
      handlers.set(q, handler);
      for (const m of pending.get(q) ?? []) deliver(q, m);
      pending.delete(q);
      return { close: async () => { handlers.delete(q); } };
    },
    ping: async () => true,
    close: async () => { handlers.clear(); },
    drain: () => new Promise<void>((r) => { if (inflight === 0) r(); else idle.push(r); }),
  };
  return t;
}

/** BullMQ rejects custom job ids containing ':' (its key separator). Enforced by both transports so tests catch it. */
export function assertJobId(jobId: string): string {
  if (!jobId || jobId.includes(":")) throw new Error(`invalid jobId (empty or contains ':'): ${jobId}`);
  return jobId;
}

/** Typed producer: validates the full envelope with zod before anything leaves the process. */
export function createProducer(transport: QueueTransport) {
  return {
    async send<Q extends QueueName>(queue: Q, tenantId: string, payload: Message<Q>["payload"], opts: SendOptions = {}): Promise<Message<Q>> {
      const msg = parseMessage(queue, {
        messageId: randomUUID(), tenantId, createdAt: new Date().toISOString(), attempt: 0, payload,
        ...(opts.traceparent ? { traceparent: opts.traceparent } : {}),
      });
      await transport.add(queue, msg, { jobId: opts.jobId ?? msg.messageId, ...(opts.delayMs ? { delayMs: opts.delayMs } : {}) });
      return msg;
    },
  };
}
export type Producer = ReturnType<typeof createProducer>;

/** Typed consumer: every job is parsed with the queue's zod schema before the handler sees it. */
export function consume<Q extends QueueName>(transport: QueueTransport, queue: Q, handler: Handler<Q>, concurrency = 4) {
  return transport.consume(queue, async (data) => handler(parseMessage(queue, data)), concurrency);
}

/** Tenant-prefixed object key (ADR 0007). Rejects path traversal in parts. */
export function tenantKey(tenantId: string, ...parts: string[]): string {
  for (const p of [tenantId, ...parts]) if (!p || p.includes("..") || p.startsWith("/")) throw new Error(`invalid key part: ${p}`);
  return ["tenants", tenantId, ...parts].join("/");
}
