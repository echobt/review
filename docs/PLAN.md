# Delivery Plan

Status: PROPOSAL. Durations are estimates for a team of 4-6 engineers. Architecture: [ARCHITECTURE.md](ARCHITECTURE.md). Decisions: [adr/](adr/README.md).

## Phase 0: Foundation / skeleton (weeks 1-3)

Scope: monorepo, the six service shells, shared packages, local dev stack, CI.

Deliverables:
- pnpm workspace, Node 24, TS strict; packages `@platform/schemas`, `db`, `queue`, `models`, `telemetry`, `crypto`.
- Service shells: `api-gateway`, `indexer-worker`, `review-orchestrator`, `agent-runner`, `sandbox-runner`, `scoring-service`, each with health endpoint and OTel bootstrap.
- docker compose: Postgres 16 + pgvector, Valkey, MinIO, OTel collector.
- Migrations for all core entities with RLS enabled; typed BullMQ queues `index.requested`, `review.requested`, `agent.task`, `sandbox.run`, `score.requested` and events `review.completed`, `finding.created`.
- GitHub App registration + webhook signature verification.

Exit criteria:
- `pnpm install && pnpm build && pnpm test` green in CI in under 10 minutes.
- RLS test suite: 100% of tenant tables reject cross-tenant reads/writes (automated test per table).
- One end-to-end trace spans gateway, queue, and a worker in the local collector.

Risks: over-scaffolding before real workloads; RLS mistakes early becoming systemic (mitigation: per-table RLS test is a CI gate).

## Phase 1: Indexing (weeks 4-7)

Scope: repository ingestion, symbol graph, chunks, embeddings, retrieval API.

Deliverables:
- `indexer-worker` full + incremental indexing; tree-sitter grammars for TS/JS, Python, Go, Java, Rust; optional SCIP ingest.
- Chunk embeddings in pgvector with HNSW; retrieval function (symbol neighborhood + ANN with tenant/index filter).
- Encrypted source blobs in object store with tenant DEK.

Exit criteria:
- Index a 1M-LOC repo in < 20 min; incremental index of a 50-file push in < 60 s (p95).
- Retrieval recall@10 >= 0.8 on an internal 200-query labeled set.
- HNSW query p95 < 50 ms at 10M Chunks on reference hardware.

Risks: grammar gaps for niche languages; embedding cost on huge monorepos (mitigation: content-hash dedup, cheap embed tier, path exclusions).

## Phase 2: Review engine MVP (weeks 8-12)

Scope: end-to-end PR review with comments posted back.

Deliverables:
- `review-orchestrator` planning, fan-out, merge/dedup, comment cap; `agent-runner` with model router (tiers, budget caps, fallback); PR summary + inline comments + check run.
- Feedback capture (thumbs, resolved, dismissed) and suppression.
- Tenant config: Rules, path filters, tier overrides.

Exit criteria:
- p95 webhook-to-first-comment < 5 min for PRs < 1k changed lines.
- Precision >= 0.6 on internal benchmark of 100 PRs; median cost <= $0.50 per PR.
- Provider outage drill: primary provider blocked, reviews complete via fallback with < 10% failure rate.
- 3 design-partner tenants live.

Risks: noisy comments eroding trust (mitigation: confidence threshold, cap, feedback suppression); provider rate limits; prompt injection from repo content.

## Phase 3: Security + test generation (weeks 13-18)

Scope: Semgrep hybrid, sandbox execution, test generation.

Deliverables:
- `sandbox-runner` with Firecracker (SaaS) and gVisor `runsc` (self-host); no-network default, CPU/mem/time limits, snapshot restore.
- Semgrep OSS in sandbox + LLM triage; SARIF export.
- Test generation with up to 3 repair loops; reproduced bugs become Findings.

Exit criteria:
- Semgrep triage reduces false positives by >= 50% vs raw Semgrep on OWASP Benchmark subset with recall loss <= 5%.
- Testgen: >= 40% of runs produce passing, non-trivial tests on target repos; sandbox cold start p95 < 2 s (Firecracker snapshot).
- External sandbox-escape pentest: zero critical/high findings.

Risks: build environment diversity (mitigation: language base images + devcontainer detection); sandbox escape; cost of repair loops (mitigation: attempt cap, budget cap).

## Phase 4: Scoring + public leaderboard (weeks 19-22)

Scope: `scoring-service`, integration with `github.com/echobt/code-review-scoring`.

Deliverables:
- Rubric/dataset sync with pinned versions; replay harness; LLM judge with deterministic location matching first.
- ScoreReport per run and per release; CI gate blocking model/prompt changes that regress.
- Leaderboard export conforming to the public dataset schema, submitted via PR.

Exit criteria:
- Score is reproducible: two runs of same config differ by <= 1 point on the rubric scale.
- Judge agreement with human labels >= 0.8 (Cohen kappa >= 0.6) on 200 labeled findings.
- First leaderboard submission merged upstream.

Risks: judge bias toward own model family (mitigation: cross-family judge, human-labeled calibration set); schema drift in the public repo (mitigation: version pin + contract test); benchmark overfitting.

## Phase 5: Enterprise self-host / SOC 2 (weeks 23-32)

Scope: single-tenant and air-gapped deployment, compliance.

Deliverables:
- Helm chart + compose bundle; offline image + Semgrep rule + grammar bundle; vLLM routing; Vault transit / HSM for KEKs.
- SSO (OIDC/SAML), SCIM, RBAC, audit-log export, data retention controls, BYOK.
- SOC 2 Type I controls, evidence automation; Type II observation window started.

Exit criteria:
- Air-gapped install from bundle completes in < 2 h on a clean cluster with no outbound network (verified in a disconnected lab).
- SOC 2 Type I report issued.
- BYOK key revocation renders tenant data unreadable within 15 min (drill).

Risks: local model quality gap (mitigation: publish self-host scores on same rubric); support burden of heterogeneous clusters; audit timeline slips.
