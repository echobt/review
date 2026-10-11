# Backend layout

> Superseded in part: this file described the Phase-0 skeleton. Current per-package status lives in [IMPLEMENTATION-STATUS.md](IMPLEMENTATION-STATUS.md); the message contracts below are still accurate, plus `index.requested.mode`/`indexId`, `sandbox.run.limits` and `score.requested.scoreId`.

**FACT** = exists and is checked in this repo. **PROPOSAL** = planned (see `PLAN.md`).

## Monorepo layout (pnpm workspaces) - FACT
```
packages/
  core/            @review/core            schemas, API + queue contracts (no I/O)
  client/          @review/client          REST/SSE client
  sdk/             @review/sdk             high-level SDK
  scoring-client/  @review/scoring-client  public scoring client + reference scorer
services/
  common/              @review/service-common  config, secrets, typed BullMQ producer/consumer, ModelRouter
  api-gateway/         Fastify REST API (auth hook, zod validation, enqueue) + sql/001_init.sql (RLS schema)
  indexer-worker/      consumes index.requested
  review-orchestrator/ consumes review.requested
  agent-runner/        consumes agent.task
  sandbox-runner/      consumes sandbox.run
  scoring-service/     consumes score.requested
scripts/
  validate-model.ts    OpenRouter end-to-end routing check (docs/VALIDATION.md)
  check-mermaid.mjs    render-checks every mermaid block in docs/
docker-compose.yml     postgres(pgvector pg16) + valkey + api
docs/scoring/          rubric, JSON schemas, sample dataset, leaderboard (public repo contents)
```

## Service boundaries
| Service | Consumes | Produces | Owns | Status |
|---|---|---|---|---|
| api-gateway | HTTP | `review.requested`, `index.requested`, `score.requested` | auth, rate limit, API keys | FACT: routes + validation + tests; PROPOSAL: DB persistence, SSE fan-out from Redis pub/sub |
| indexer-worker | `index.requested` | - | repo_indexes, symbols, chunks | FACT: typed consumer stub; PROPOSAL: tree-sitter + embeddings |
| review-orchestrator | `review.requested` | `agent.task`, `review.completed` | reviews, findings | FACT: stub + test; PROPOSAL: planner/merge/verify |
| agent-runner | `agent.task` | `finding.created`, `sandbox.run` | agent_tasks | FACT: stub; ModelRouter implemented + tested |
| sandbox-runner | `sandbox.run` | results to object store | - | FACT: stub; PROPOSAL: gVisor / Firecracker |
| scoring-service | `score.requested` | score_reports | - | FACT: stub; reference scorer in `@review/scoring-client` |

## Message contracts - FACT (`packages/core/src/messages.ts`)
Every message = `Envelope { messageId (uuid), tenantId, traceparent?, createdAt, attempt }` + `payload`. Consumers run `parseMessage(queue, data)` before any work; the tenantId is then set as `app.tenant_id` for Postgres RLS (PROPOSAL for the DB wiring; policies exist in `001_init.sql`).

| Queue | Payload |
|---|---|
| `index.requested` | repositoryId, commitSha, baseIndexId?, changedPaths? |
| `review.requested` | reviewId, repositoryId, pullRequest?, diffObjectKey? |
| `agent.task` | reviewId, agentTaskId, agent (planner, bug-hunter, security, cross-file, test-gen, verifier, summarizer), tier, contextObjectKey, budgetUsd |
| `sandbox.run` | runId, image, command[], workspaceObjectKey, timeoutSec (<=3600), network (`none` default, or `egress-allowlist`) |
| `score.requested` | reviewId, datasetCaseId, rubricVersion |
| `finding.created` | finding |
| `review.completed` | reviewId, findingCount, usage |

Large blobs (diffs, context packs, workspaces) never travel on the queue; only tenant-prefixed object keys do.

## Local dev
```sh
cp .env.example .env            # throwaway local values only
docker compose up -d postgres redis
pnpm install && pnpm typecheck && pnpm test
DEV_API_KEY=dev node --experimental-strip-types services/api-gateway/src/main.ts
curl -s localhost:8080/healthz
```
`docker compose up` also starts the api container. The compose file was not executed in this phase (see `build.json`).

## Not in scope
No frontend. No provider spend in tests (all model calls are stubbed; the only real call is the opt-in `scripts/validate-model.ts`).
