import { randomUUID } from "node:crypto";
import { Queue, Worker, type ConnectionOptions, type Job } from "bullmq";
import { parseMessage, type Message, type QueueName } from "@review/core";

export const connectionFromUrl = (url: string): ConnectionOptions => {
  const u = new URL(url);
  return { host: u.hostname, port: Number(u.port || 6379), ...(u.password ? { password: decodeURIComponent(u.password) } : {}) };
};

/** BullMQ queue names may not contain ':'; dots are fine. */
export function makeProducer<Q extends QueueName>(queue: Q, connection: ConnectionOptions) {
  const q = new Queue(queue, { connection });
  return {
    async send(tenantId: string, payload: Message<Q>["payload"], traceparent?: string) {
      const msg = parseMessage(queue, {
        messageId: randomUUID(), tenantId, createdAt: new Date().toISOString(), attempt: 0, payload,
        ...(traceparent ? { traceparent } : {}),
      });
      await q.add(queue, msg, { jobId: msg.messageId, attempts: 5, backoff: { type: "exponential", delay: 2000 }, removeOnComplete: 1000 });
      return msg;
    },
    close: () => q.close(),
  };
}

/** Typed consumer: every job is zod-validated before the handler runs; invalid jobs fail without retry semantics leaking bad data. */
export function makeConsumer<Q extends QueueName>(
  queue: Q, connection: ConnectionOptions, handler: (msg: Message<Q>, job: Job) => Promise<void>, concurrency = 4,
) {
  return new Worker(queue, async (job) => handler(parseMessage(queue, job.data), job), { connection, concurrency });
}
