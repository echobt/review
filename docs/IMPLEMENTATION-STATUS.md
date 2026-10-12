# Implementation status

As of 2026-10-12, branch `boat/1da9053f5295` (GREPTILE-GAP capabilities 1-7 added on top of `boat/c086bbfcb55e`). **Implemented** means the code is present and exercised by passing tests, and where noted by a live run against the docker compose stack. **Stub / boundary** means the interface and payloads exist but no production backend is wired or proven. Evidence for every number below is in the job directory's `build.json` and `logs/`.

Checks: `pnpm -r build` (`tsc --noEmit` per package, TypeScript 5.9.3) exits 0. `pnpm -r test` (Vitest) exits 0 with 191 tests across 18 packages (181 before the latency work) (the 26 RLS tests that need `RLS_DATABASE_URL` are skipped without it). That run includes the per-table RLS suite against Postgres 16 (`RLS_DATABASE_URL`). A clean install, build and test takes about 45 s on the build host.

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
| `indexer-worker` | tree-sitter (WASM) parsing for TS, TSX, JS, Python, Go, Java, Rust, Ruby, with class bases and abstract markers; `LocalCodeIndex` (commit-pinned, grep-narrowed definitions/members/references, BM25 + hash-vector + symbol-graph search fused by RRF) used by the review path; entities plus call/import/var edges; AST-aligned chunking; embeddings in pgvector with a content-hash cache; hybrid retrieval (vector + tsvector lexical + symbol graph depth 2, fused with RRF); full and incremental indexing keyed by blob SHA; source blobs and chunk text envelope-encrypted with the tenant DEK; git and in-memory repository sources | SCIP ingest not implemented (the per-language indexer map exists; resolution is tree-sitter + import paths); lexical ranking uses `ts_rank_cd` (BM25-like, not true BM25); call resolution is name-only; non-code text files are stored but not indexed |
| `review-orchestrator` | **Multi-agent engine** (when an indexer, a router and the PR head SHA are present): `ensureIndexed(repo, headSha)` -> token-budgeted context pack (full changed files, definitions of touched identifiers, base classes with unimplemented abstract members, callers/tests, import existence exists/missing/external+version, toolchain versions, repo rule files, related code) -> planner (cheap tier, hypotheses capped 8/20/40 by `reviewDepth`) -> parallel hypothesis hunters + one free hunt per file group (standard tier; frontier for security/contract/concurrency on deep) with `get_definition`/`find_references`/`read_file`/`search` tools -> verifier (frontier) that must cite a line and quote evidence present in repo text -> E0-E3 execution when enabled -> learned suppression; per-language prompt addenda (Python, TypeScript, JavaScript, Go, Java, Ruby). Single-pass path otherwise: diff parsing, tenant path filters, natural-language rules injected per path, planning into review units and agent kinds, fan-out, fingerprint dedup, feedback suppression, confidence threshold, comment cap ranked by severity x confidence, summary, GitHub review + inline comments + check run payloads behind a `GitHubClient` port (recording mock + fetch implementation), events; a review fails when every agent fails, and the summary flags a partial review | GitHub App JWT to installation-token exchange not built (token comes from `GITHUB_TOKEN`); comments are not mapped to diff hunks; agents run in-process, not as `agent.task` jobs |
| `agent-runner` | One agent per call via `ModelRouter.json`, tier overrides from tenant config, untrusted repo content fenced in prompts, partial results on budget exhaustion, `agent_tasks` + `usage_ledger` rows, `agent.task` queue handler (context in, results out through the object store) | Retrieval tool calls (agent asks for more context) not implemented; context is precomputed |
| `sandbox-runner` | Execution validation: E0 compile/type checks (py_compile + mypy, tsc, go build/vet, javac, ruby -c), E1 python import + abstract-class smoke, E2 tests referencing changed symbols, E3 hunter-written hypothesis tests; only diagnostics within 3 lines of an added line become findings, with command/exit code/stderr evidence; `SandboxDriver` interface with validation (no network by default, cpu/mem/pids/time caps, secret-looking env rejected, never falls back to runc); gVisor driver (`docker --runtime=runsc` argv, no shell); Firecracker VM config + jailer args; mock driver; Semgrep in sandbox, SARIF 2.1.0 parsing, LLM triage, SARIF export; test generation plan -> generate -> run -> repair (at most 3 repairs) keeping only building, passing, deterministic (2 runs), coverage-increasing tests; reproducers upgrade findings; `sandbox.run` handler | gVisor and Firecracker were not run on this host (no `runsc`, no KVM launcher); the Firecracker launcher is a port with no implementation; Semgrep binary not installed here, so parsing is tested from a fixture SARIF |
| `scoring-service` | Rubric v1.0.0 scoring (composite unchanged) plus F0.5, acceptance/resolution rates, latency p50/p95 and cost reported next to the score; deterministic location matching first, optional `Judge` (LLM judge behind an interface) only for same-path near misses; replay harness; `score.requested` handler persisting ScoreReports; regression gate CLI; leaderboard export validated against the public schema | Judge agreement calibration (Phase 4 exit) and upstream submission not done; dataset is the synthetic `sample-0.1` |

## GREPTILE-GAP capabilities (docs/research/GREPTILE-GAP.md)

| # | Capability | Where | Tests | Not done |
|---|---|---|---|---|
| 1 | Benchmark harness + greptile-50 dataset | `scripts/bench/` (`extract`, `run`, `judge`, `report`), `docs/scoring/datasets/greptile-50/dataset.json` (50 cases, pinned SHAs) | `scripts/bench/test` | Only the 10 Sentry labels are human-verified; the other 40 are auto-picked from catching-tool comments (`labelSource`); Keycloak-04 is unlabelled (no tool caught it). 3-run stability not done |
| 2 | Context pack + agent tools in the review path | `review-orchestrator/src/pack.ts`, `review.ts`; `indexer-worker/src/local-index.ts` | `pack.test.ts`, `local-index.test.ts` | Pack coverage gate (>= 90%) measured only on Sentry; pgvector index not used by this path (local git mirrors) |
| 3 | Planner / hunters / verifier | `review-orchestrator/src/review.ts`, `orchestrator.ts` | `pipeline.test.ts` | Confidence calibration (isotonic) not fitted |
| 4 | Distinct cheap/standard/frontier tiers from env | `packages/models` (`MODEL_SMALL/MEDIUM/LARGE`, `_PRICE`, `MODEL_PROVIDER=gateway`) | `tiers.test.ts`, `pipeline.test.ts` | Cross-family routing rule not implemented |
| 5 | Execution validation E0-E3 | `sandbox-runner/src/execution.ts`; wired via `REVIEW_EXECUTION=1` | `execution.test.ts` (real python E0/E1) | Not run in gVisor here (no `runsc`); no per-repo dependency images, so E0/E1 on Sentry would import-fail and are skipped |
| 6 | Learned rules | rule files (`AGENTS.md`, `CLAUDE.md`, `.cursorrules`, `.review/rules.md`) in the pack; `learning.ts` suppression from dismissed feedback with security/high guardrail | `learning.test.ts`, `pack.test.ts` | Reply-derived natural-language rules pending admin approval not built |
| 7 | Per-language support | `languages.ts` (addenda, SCIP indexer names), ruby grammar, import resolution and manifest versions for 6 languages | `languages.test.ts`, `local-index.test.ts` | SCIP binaries not invoked |

## LATENCY-PLAN (docs/research/LATENCY-PLAN.md)

| # | Item | Where | Tests | Not done / stubbed |
|---|---|---|---|---|
| 1 | Standing index: one blob-SHA-keyed cache per repo shared by all commits and PRs; `lookup`/`head`/`update`/`invalidate`/`warm`; Postgres `branch_heads` (RLS, migration 004), `readyIndexForCommit`/`setBranchHead`/`invalidateBranchHead`; push webhook enqueues `index.requested{branch}`; an already-indexed commit is never rebuilt | `indexer-worker/src/standing.ts`, `indexer.ts`, `db/src/store.ts`, `api-gateway/src/app.ts` | `standing.test.ts`, `indexer.test.ts`, `phase2.test.ts`, `rls.test.ts` | Review path serves the in-process standing index; a `PgCodeIndex` (SQL-backed tools) and content-addressed facts (no row copy on push) are not built |
| 2 | Parallelism: `createLimiter`; free hunts start next to the planner; one tier-capped pool (fast 8 / standard 16 / deep 24) for hunters + verifiers; verify streams per candidate (no barrier); tool calls of a round run concurrently; `finding` events stream partial results | `models/src/limit.ts`, `review-orchestrator/src/review.ts` | `limit.test.ts`, `latency.test.ts` | Check run is not posted `in_progress` incrementally; per-provider semaphore in `ModelRouter` not added |
| 3 | Prompt caching: one fence per review, shared cache-marked prefix (system + pack + diff) for every hunter/verifier, `cache_control` blocks + `session_id` (OpenRouter default on, gateways opt-in via `GATEWAY_PROMPT_CACHE=1`), cached tokens recorded; verifier grounding pack rendered once per review (was 200k tokens per candidate); embeddings stay cached by content hash in `embedding_cache` | `models/src/provider.ts`, `env.ts`, `review.ts` | `latency.test.ts` (prefix identity, wire format, cached-token parsing) | Savings not measured live: the bench gateway was run without cache_control (opt-in off), so `cachedTok` = 0 |
| 4 | Cheap path first: E0/E1 start at t=0 in parallel with indexing/LLM; LLM candidates at a location an execution check already failed skip the frontier verifier; pack-level missing imports are escalated as verifier candidates; `reviewDepth: "auto"` | `orchestrator.ts`, `tier.ts` | `latency.test.ts`, `pipeline.test.ts` | Semgrep is not wired into the review path; auto thresholds are uncalibrated |
| 5 | Repo access: `RepoCache` = one bare partial mirror per repo (`--filter=blob:limit=1m`, never shallow), single-flight incremental fetch per commit (lazy fetch disabled for the presence check), worktree per review removed in `finally` | `review-orchestrator/src/repo-cache.ts`, `main.ts`, `scripts/bench/run.ts` | `latency.test.ts` (real git) | File reads come from the mirror via the in-process index, not object-store blobs |
| 6 | Instrumentation: `phase_start/phase_end`, `llm` (role, model, latency, tokens, cached), `tool` (ms), `heap` every 10 s; `--warm`; report p50/p95/max, per-phase p50/p95, LLM calls/PR, cache hit ratio, peak heap, SLO (p50 <= 150 s, p95 <= 300 s) verdict | `scripts/bench/run.ts`, `report.ts` | `bench.test.ts` | OTel spans per phase not added (events only) |

### Live Sentry 10-case run (2026-10-12, `bench-runs/latency-1` in the job dir)

Command: `node --max-old-space-size=4096 scripts/bench/run.ts --repo sentry --mirrors <mirrors> --out <run> --concurrency 1 --warm --depth standard`, then `judge.ts` (LLM judge `cx/gpt-6-sol` x3) and `report.ts`.
Models: an OpenAI-compatible coding gateway (no OpenRouter key on this host). DeepSeek and GLM returned 429, so tiers were small `cx/gpt-5.6-sol`, medium `cx/gpt-5.6-terra`, large `cx/gpt-6-sol`, with `MODEL_TIMEOUT_MS=600000`. That is a different model set from the baseline run, so the comparison is not like-for-like.

| Metric | Baseline (multi-agent, before) | This run | Target |
|---|---|---|---|
| Catch rate | 4/10 | **3/10** (sentry-02, -07, -10); 6 of 10 cases partial | >= 4/10 |
| Latency p50 | ~23 min (~1,380 s) | **788 s** | <= 150 s |
| Latency p95 / max | max ~62 min, sentry-01 OOM at ~78 min | **1,154 s** / 1,154 s | <= 300 s |
| Median cost / PR | $2.48 | $2.67 (gateway has no prices; budget used tier list prices) | <= $2.48 |
| LLM calls / PR (median) | not measured | 33 | - |
| Prompt cache hit ratio | 0 | 0 (cache_control not sent to this gateway) | - |
| Peak heap | OOM | 3,182 MB, climbing every case (544 MB on case 1) | below worker limit |

Phase p50 / p95 (s): context pack 12 / 102, planner 602 / 656, hunt task 865 / 1,946 (sum over the pool), verify 182 / 384, summary 8 / 18, index lookup 0.

**SLO not met.** The parallelised steps take seconds; the critical path is single gateway calls that stall for minutes. The planner hit the 600 s per-call timeout on 6 of 10 cases, so those cases ran with no hypotheses (free hunt only). That probably explains the recall loss. Hunter calls stalled for 500-700 s on most cases. The cleanest case (sentry-08) took 218 s, and its single planner call took 135 s of that.

Open issues from the run (not fixed; they change engine behaviour):
- No per-call deadline below 600 s, no planner output cap (one planner call produced 14,264 output tokens).
- `git grep` output above 64 MB fails the tool call (sentry-05) instead of being truncated; this bug predates this work.
- Peak heap grows across cases in one process (standing-index blob/parse cache bounded by entry count, not bytes); bound by bytes before production.

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
