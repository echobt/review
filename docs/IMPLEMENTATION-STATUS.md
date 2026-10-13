# Implementation status

As of 2026-10-11, branch `boat/c086bbfcb55e`. **Implemented** means the code is present and exercised by passing tests, and where noted by a live run against the docker compose stack. **Stub / boundary** means the interface and payloads exist but no production backend is wired or proven. Evidence for every number below is in the job directory's `build.json` and `logs/`.

Checks: `pnpm -r build` (`tsc --noEmit` per package, TypeScript 5.9.3) exits 0. `pnpm -r test` (Vitest) exits 0 with 184 tests across 17 packages/services. That run includes the per-table RLS suite against Postgres 16 (`RLS_DATABASE_URL`). A clean install, build and test takes about 45 s on the build host.

## Shared packages

| Package | Implemented | Stub / boundary / not done |
|---|---|---|
| `@review/core` | zod contracts: domain (`Finding`, `Review`, `Rule`, `RepoIndex`, `TestGenRun`, `ScoreReport`, `Feedback`, `TenantConfig`, `SandboxLimits`, `ModelTier` small/medium/large, `AgentKind`), REST requests + `routes` table, SSE `ReviewEvent`, async `ScoreJob`, queue envelopes for all 5 jobs + 2 events | - |
| `@review/db` | Migrations for all core entities (23 tenant tables), pgvector + HNSW + GIN tsvector indexes, `review_app` non-owner role without BYPASSRLS, generated RLS (ENABLE + FORCE, USING + WITH CHECK, fail closed when `app.tenant_id` unset) on **every** tenant table, append-only grants for `audit_log`/`usage_ledger`, SECURITY DEFINER lookups for API keys/installations, `withTenant` (SET LOCAL in a transaction), tenant-scoped store, migrate CLI, PGlite test harness | Partitioning large `chunks` per tenant (ADR 0003) not done |
| `@review/queue` | Typed zod-validated producer/consumer, BullMQ transport (Valkey), `evt.*` fan-out for events, idempotent job ids (BullMQ-safe), in-memory transport, tenant-prefixed object keys | Queue key prefix is global `review`, not `t:{tenantId}:`; per-tenant rate-limit groups not configured |
| `@review/models` | `LLMProvider` (chat, tools, JSON, embeddings), OpenAI-compatible adapter (OpenRouter, vLLM, Azure gateway via env), tier routing small/medium/large + embed, per-PR and per-tenant budgets (reserve then reconcile), full-jitter retry, provider fallback, tier downgrade, circuit breaker, zod structured output with one repair round, deterministic offline hash embeddings | Budget ledger is in-memory per process (`usage_ledger` rows are written, but caps are not enforced across processes yet); native Bedrock adapter not written (use an OpenAI-compatible gateway) |
| `@review/telemetry` | OTel tracer provider with OTLP/HTTP export, redacting span processor (code/prompt/secret keys dropped, token patterns scrubbed, tenant id hashed), redacting JSON logger, traceparent propagation through queue messages | Metrics and log export over OTLP not wired (traces only) |
| `@review/crypto` | AES-256-GCM envelope encryption with per-tenant KEK, DEK cache capped at 5 min, context-bound ciphertext, `LocalKms` (mock/dev; HKDF from master key file), `VaultTransitKms` (real HTTP boundary, tested with mocked fetch) | Cloud KMS (AWS/GCP) adapters not written; Vault path not exercised against a live Vault |
| `@review/schemas` | JSON Schema derivation of core contracts, `FindingDraft(List)` for LLM structured output | OpenAPI document generation not done |
| `@review/service-common` | Config, secrets (`NAME` / `NAME_FILE`), health (`/healthz`) + readiness (`/readyz`) server, `runWorker` bootstrap with spans, S3/MinIO-compatible and in-memory object stores | - |

## Services

All six boot against the compose stack (Postgres 16 + pgvector, Valkey, OTel collector) and return 200 on `/healthz` and `/readyz` (`logs/health.log`).

| Service | Implemented | Stub / boundary / not done |
|---|---|---|
| `api-gateway` | Fastify REST API for every route in `routes`; API-key auth via hashed keys; GitHub webhook HMAC-SHA256 verification on the raw body (constant time); `pull_request` opened/synchronize/reopened creates a review with a deterministic id; SSE review events; feedback; tenant config GET/PUT; indexes; test-gen; async scores; request ids; a span per request | API-key issuance endpoint and rate limiting not built; SSO/RBAC (Phase 5) not started |
| `indexer-worker` | tree-sitter (WASM) parsing for TS, TSX, JS, Python, Go, Java, Rust; entities plus call/import/var edges; AST-aligned chunking; embeddings in pgvector with a content-hash cache; hybrid retrieval (vector + tsvector lexical + symbol graph depth 2, fused with RRF); full and incremental indexing keyed by blob SHA; source blobs and chunk text envelope-encrypted with the tenant DEK; git and in-memory repository sources | SCIP ingest not implemented; lexical ranking uses `ts_rank_cd` (BM25-like, not true BM25); call resolution is name-only; non-code text files are stored but not indexed |
| `review-orchestrator` | Diff parsing, tenant path filters, natural-language rules injected per path, planning into review units and agent kinds, fan-out, fingerprint dedup, feedback suppression, confidence threshold, comment cap ranked by severity x confidence, summary, GitHub review + inline comments + check run payloads behind a `GitHubClient` port (recording mock + fetch implementation), events; a review fails when every agent fails, and the summary flags a partial review | GitHub App JWT to installation-token exchange not built (token comes from `GITHUB_TOKEN`); comments are not mapped to diff hunks; agents run in-process, not as `agent.task` jobs |
| `agent-runner` | One agent per call via `ModelRouter.json`, tier overrides from tenant config, untrusted repo content fenced in prompts, partial results on budget exhaustion, `agent_tasks` + `usage_ledger` rows, `agent.task` queue handler (context in, results out through the object store) | Retrieval tool calls (agent asks for more context) not implemented; context is precomputed |
| `sandbox-runner` | `SandboxDriver` interface with validation (no network by default, cpu/mem/pids/time caps, secret-looking env rejected, never falls back to runc); gVisor driver (`docker --runtime=runsc` argv, no shell); Firecracker VM config + jailer args; mock driver; Semgrep in sandbox, SARIF 2.1.0 parsing, LLM triage, SARIF export; test generation plan -> generate -> run -> repair (at most 3 repairs) keeping only building, passing, deterministic (2 runs), coverage-increasing tests; reproducers upgrade findings; `sandbox.run` handler | gVisor and Firecracker were not run on this host (no `runsc`, no KVM launcher); the Firecracker launcher is a port with no implementation; Semgrep binary not installed here, so parsing is tested from a fixture SARIF |
| `scoring-service` | Rubric v1.0.0 scoring (composite unchanged) plus F0.5, acceptance/resolution rates, latency p50/p95 and cost reported next to the score; deterministic location matching first, optional `Judge` (LLM judge behind an interface) only for same-path near misses; replay harness; `score.requested` handler persisting ScoreReports; regression gate CLI; leaderboard export validated against the public schema | Judge agreement calibration (Phase 4 exit) and upstream submission not done; dataset is the synthetic `sample-0.1` |

## SDKs

| Package | Implemented | Not done |
|---|---|---|
| `@review/client` | Every route, zod-validated requests and responses, GET retry with jittered backoff on 429/5xx (writes never retried), SSE with one `Last-Event-ID` resume | Build step to `dist/` for npm publishing |
| `@review/sdk` | `reviewPullRequest`, `reviewDiff`, `indexRepo`, `generateTests`, `scoreReview` (polls the async ScoreJob), `verifyWebhookSignature`; auth only from options, `REVIEW_API_KEY`, or `REVIEW_API_KEY_FILE` | Same |
| `@review/scoring-client` | Reference scorer (normative), F0.5, feedback rates, leaderboard builder, regression gate, judge interfaces, public repo client | Same |

## Verified live (docker compose, this host)

- Migrations apply as the owner and are idempotent; `review_app` has `rolbypassrls = false` (`logs/migrate.log`).
- The RLS suite (26 tests per target) passes on Postgres 16 (`logs/rls-pg16.log`).
- Six services healthy (`logs/health.log`). Spans reach the OTel collector.
- Smoke (`logs/smoke-review.log`): an authenticated `POST /v1/reviews` goes through BullMQ to the orchestrator and agent-runner calls, then the review is read back through `GET` and SSE. With no `OPENROUTER_API_KEY` on this host, every agent fails with "provider not configured" and the review is marked `failed`. That is the intended behavior.
- Service logs contain no diff text, API key, or object-store secret.

## Not verified / blocked

- **Live model call:** `node scripts/validate-model.ts` printed `SKIPPED: set OPENROUTER_API_KEY or OPENROUTER_API_KEY_FILE` (exit 2). No key is available here, so the OpenRouter path is unproven live.
- **MinIO:** the `minio/minio` image needs registry auth on this host. Compose uses RustFS (S3-compatible) instead, which the smoke used successfully.
- **CI:** `.github/workflows/ci.yml` has not run on GitHub (nothing pushed). The local full install, build and test takes about 45 s.
