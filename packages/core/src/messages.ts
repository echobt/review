import { z } from "zod";
import { AgentKind, Finding, ModelTier, PullRequestRef, SandboxLimits, Usage } from "./schemas.ts";

// Inter-service queue contracts. Every message carries an envelope with tenant scope
// so workers can set the Postgres RLS tenant before touching data.

export const Envelope = z.object({
  messageId: z.string().uuid(),
  tenantId: z.string().min(1),
  traceparent: z.string().optional(),
  createdAt: z.string().datetime({ offset: true }),
  attempt: z.number().int().nonnegative().default(0),
});
export type Envelope = z.infer<typeof Envelope>;

const msg = <T extends z.ZodRawShape>(shape: T) => Envelope.extend({ payload: z.object(shape) });

export const messages = {
  "index.requested": msg({
    indexId: z.string().optional(),
    repositoryId: z.string(),
    commitSha: z.string(),
    mode: z.enum(["full", "incremental"]).default("incremental"),
    baseIndexId: z.string().optional(),
    changedPaths: z.array(z.string()).optional(),
    /** Push-driven update: on success the branch head points at this index. */
    branch: z.string().min(1).max(255).optional(),
  }),
  "review.requested": msg({ reviewId: z.string(), repositoryId: z.string(), pullRequest: PullRequestRef.optional(), diffObjectKey: z.string().optional() }),
  "agent.task": msg({
    reviewId: z.string(),
    agentTaskId: z.string(),
    agent: AgentKind,
    tier: ModelTier,
    contextObjectKey: z.string(),
    budgetUsd: z.number().positive(),
  }),
  "sandbox.run": msg({
    runId: z.string(),
    image: z.string(),
    command: z.array(z.string()).min(1),
    workspaceObjectKey: z.string(),
    timeoutSec: z.number().int().min(1).max(3600),
    network: z.enum(["none", "egress-allowlist"]).default("none"),
    limits: SandboxLimits.optional(),
  }),
  "score.requested": msg({ scoreId: z.string().optional(), reviewId: z.string(), datasetCaseId: z.string(), rubricVersion: z.string() }),
  "finding.created": msg({ finding: Finding }),
  "review.completed": msg({ reviewId: z.string(), findingCount: z.number().int().nonnegative(), usage: Usage }),
} as const;

/** Jobs are consumed by exactly one worker; events fan out on evt.* queues (ADR 0002). */
export const EVENT_QUEUES = ["finding.created", "review.completed"] as const satisfies readonly (keyof typeof messages)[];
export const JOB_QUEUES = ["index.requested", "review.requested", "agent.task", "sandbox.run", "score.requested"] as const satisfies readonly (keyof typeof messages)[];

export type QueueName = keyof typeof messages;
export type Message<Q extends QueueName> = z.infer<(typeof messages)[Q]>;

export const QUEUE_NAMES = Object.keys(messages) as QueueName[];

/** Parse an untrusted queue payload for the given queue. Throws ZodError on mismatch. */
export function parseMessage<Q extends QueueName>(queue: Q, data: unknown): Message<Q> {
  return messages[queue].parse(data) as Message<Q>;
}
