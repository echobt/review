# ADR 0002: Job queue: BullMQ on Redis/Valkey

- Status: Accepted (PROPOSAL until Phase 0 exit)
- Date: 2026-10-11
- Related: [ARCHITECTURE.md](../ARCHITECTURE.md), [PLAN.md](../PLAN.md)

## Context

Work is asynchronous and bursty (PR spikes). We need retries with backoff, delayed jobs, rate limiting per tenant and per provider, job priorities, parent/child flows (ReviewRun fans out to AgentTasks), and something that runs in self-host and air-gapped installs with minimal ops.

## Decision

- BullMQ on Redis-protocol store (Valkey preferred for licensing; Redis acceptable). Queues: index.requested, review.requested, agent.task, sandbox.run, score.requested. Events review.completed and finding.created published to fan-out queues (evt.*) consumed by subscribers.
- BullMQ Flows model ReviewRun -> AgentTask parent/child completion.
- Job payloads validated by zod; payloads carry IDs only (no source code); tenant prefix in keys (ADR 0007); OTel traceparent in job data.
- Idempotency: jobId = deterministic key (e.g. reviewRunId + headSha); consumers are idempotent.
- Valkey with AOF everysec + replica; Postgres remains source of truth, so lost jobs are re-derivable by a reconciler that re-enqueues stuck ReviewRuns.

## Alternatives considered

- **Kafka / Redpanda**: great for event streaming and replay, poor fit for per-job retries/delays/priorities; heavy for self-host.
- **RabbitMQ**: solid, but no native flows/rate-limit groups; another stateful system to run.
- **Temporal**: excellent durable workflows; significant ops footprint and learning curve; reconsider if orchestration logic outgrows Flows.
- **SQS / Cloud Tasks**: not available air-gapped.
- **Postgres-based (pg-boss, graphile-worker)**: fewer moving parts, but higher DB load at fan-out volume and weaker rate limiting.

## Consequences

- Positive: mature TS API, flows, per-group rate limiting, simple to run.
- Negative: Redis is memory-bound and not a durable log; event fan-out is a convention, not a real pub/sub with replay. Mitigated by Postgres source of truth and a reconciler.
- Revisit triggers: > 10 event consumers or external event subscribers, or need for long-running human-in-the-loop workflows (Temporal).
