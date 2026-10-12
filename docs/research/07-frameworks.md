# 07 — Framework and stack decisions

Labels: **FACT** = a claim backed by a cited source in [`SOURCES.md`](./SOURCES.md). **PROPOSAL** = our rationale. Every decision in this doc is **fixed**. This doc justifies them and records the rejected alternatives.

## Summary table

| Concern | Decision | Rejected (v1) |
|---|---|---|
| Language/runtime | TypeScript on **Node.js 24 LTS** | Go, Python services |
| Repo layout | **pnpm workspaces** monorepo | Nx/Turborepo-only, polyrepo |
| HTTP API | **Fastify** + **zod** | Express, NestJS, Hono |
| Jobs | **BullMQ** on Redis/**Valkey** | Kafka, Temporal (phase-3 candidate), SQS |
| DB + vectors | **PostgreSQL 16 + pgvector (HNSW)** | Pinecone, Qdrant, Weaviate |
| Code parsing | **tree-sitter** (web-tree-sitter WASM / node bindings) + optional **SCIP** | LSIF, LSP-at-runtime, regex |
| Sandbox | **gVisor (runsc)** self-host/local; **Firecracker** SaaS | Plain Docker; Kata = alternative |
| LLM access | **OpenAI-compatible provider abstraction** + tier routing + budget + fallback | Single-vendor SDK lock-in, LangChain as core |
| Multi-tenancy | **Postgres RLS (tenant_id)** + per-tenant KMS envelope keys + per-tenant queue/object prefixes | DB-per-tenant (default), schema-per-tenant |
| SAST | **Semgrep OSS** + LLM triage | CodeQL bundled, LLM-only |
| Tests | **Vitest** | Jest, node:test |
| Observability | **OpenTelemetry** | Vendor-specific agents |

## 1. TypeScript on Node.js 24 LTS, pnpm workspaces

**FACT**
- Node.js v24 is the current "Latest LTS" line. Even-numbered releases enter Active LTS [S180].
- pnpm workspaces are defined by `pnpm-workspace.yaml` and link internal packages through the `workspace:` protocol [S181].
- Official tree-sitter WASM bindings exist [S104], and SCIP ships TypeScript bindings [S105].

**PROPOSAL — rationale**
- One language across the API, workers and the **TypeScript SDKs** this repo ships. SDK types are generated from the same zod schemas, so there is no type drift.
- The LTS line gives the long support window self-host customers expect.
- pnpm's strict `node_modules` layout catches undeclared dependencies, and its content-addressed store keeps CI fast.
- Layout: `packages/{api,worker-index,worker-review,worker-testgen,core,llm,sandbox,sdk}`.

**Rejected**
- **Go**: strong for workers, but splits the codebase and the SDK types.
- **Python**: best ML ecosystem, but we only call models over HTTP, so that advantage does not apply.

## 2. Fastify + zod

**FACT**
- Fastify compiles schemas into fast validation and serialization functions. It isolates components with plugin encapsulation and ships Pino logging; v5 targets Node 20+ [S182].
- `fastify-type-provider-zod` lets zod schemas serve as route schemas [S183]. Zod is TypeScript-first schema validation [S184].

**PROPOSAL**
- The webhook and API layers sit at a **trust boundary**, so input validation is mandatory. zod schemas are the single source of truth for validation, OpenAPI generation, SDK types and the finding contract (doc 03 §6).
- Plugin encapsulation maps cleanly to a per-request tenant context, the hook that sets `app.tenant_id` (doc 06).

**Rejected**
- **Express**: slower, and validation and types have to be bolted on.
- **NestJS**: heavy DI and decorator layer we don't need.
- **Hono**: good, but Fastify's ecosystem (rate limit, OTel instrumentation) is more mature for long-running Node servers.

## 3. BullMQ on Redis/Valkey

**FACT**
- BullMQ provides:
  - priorities, deduplication, delayed and repeatable jobs, retries
  - stalled-job recovery, sandboxed processors
  - global concurrency and rate limits, telemetry [S185]
  - **flows** (parent/child job dependency trees) [S186]
  - per-queue rate limiting [S191]
- Valkey is a BSD-licensed key/value store under the Linux Foundation [S187].
- Temporal provides durable workflow execution [S188].

**PROPOSAL**
- The workload is many short jobs (index a diff, review a PR, run a test round) with fan-out and fan-in. BullMQ flows model `review = parent(index, semgrep, llm passes…)` directly [S186].
- Redis or Valkey is a single extra dependency that self-hosters already know. Valkey avoids Redis licensing concerns for redistribution [S187].
- **Tenant fairness:** a per-tenant rate limiter plus priority by plan [S185][S191]. Heavy tenants get dedicated `t:{tenant}` queues (doc 06).

**Rejected**
- **Kafka**: a log, not a job queue. Retries, delays and per-job state would need to be built on top, and it is operationally heavy for self-host.
- **Temporal**: excellent durability for long, multi-step, human-in-the-loop workflows [S188], but another cluster to run, which is too much for v1. **Phase-3 candidate**: revisit when test-gen and remediation flows become long-running and need durable timers.
- **SQS**: AWS-only, which breaks self-host and air-gap; no native flows or priorities.

## 4. PostgreSQL 16 + pgvector (HNSW)

**FACT**
- pgvector supports HNSW indexes. `halfvec` allows up to 4,000 dimensions, and iterative index scans and partial indexes handle filtered queries [S115]. The HNSW algorithm comes from [S114].
- PostgreSQL 16 RLS enforces row-level tenant policies, with `FORCE ROW LEVEL SECURITY` for owners [S169].

**PROPOSAL**
- One datastore for metadata, the symbol graph, full-text search and vectors. Vector queries join tenant/repo/snapshot filters **under the same RLS policies**, so tenant isolation is enforced in one place. That property is the main reason for this choice.
- Expected scale: ~2M vectors for a large tenant monorepo (doc 02 §6) is well within pgvector HNSW territory. Shard by tenant across Postgres instances if needed.
- Backups, PITR and residency reuse standard Postgres tooling. Self-host needs no extra service.

**Rejected**
- **Pinecone**: SaaS-only (no air-gap), and a second isolation model to secure.
- **Qdrant / Weaviate**: capable, but an extra stateful system with its own auth, backups and tenancy. Revisit if a single tenant exceeds ~50M vectors or p95 latency degrades.

## 5. tree-sitter + optional SCIP

**FACT**
- tree-sitter offers incremental, error-tolerant parsing with an embeddable C11 runtime [S103] and WASM bindings [S104].
- SCIP provides compiler-grade references through per-language indexers [S105][S106]. LSIF is its predecessor [S107].

**PROPOSAL**
- Prefer `web-tree-sitter` (WASM): no native compile, and identical behaviour across OS and arch, which helps air-gap and ARM. Use the native node bindings only in the indexing worker, if profiling shows parse time dominates.
- SCIP indexers run in the sandbox because they execute builds (doc 02).

**Rejected**
- **LSIF**: superseded.
- **Running language servers live**: stateful and slow per request.
- **Regex/ctags**: too imprecise.

## 6. Sandbox: gVisor locally/self-host, Firecracker for SaaS

**FACT**
- gVisor: userspace kernel, `runsc` works with Docker and Kubernetes [S173]; syscall-surface threat model [S174].
- Firecracker: KVM microVMs with <125 ms boot, <5 MiB overhead and a minimal device model [S175]; production at AWS Lambda/Fargate [S176].
- Kata: containers in lightweight VMs [S177].

**PROPOSAL**
- **SaaS**: Firecracker gives VM-level isolation for multi-tenant untrusted code at container-like startup cost.
- **Self-host**: gVisor works on ordinary Docker hosts without nested virtualization or `/dev/kvm`, which many customer VMs lack.

**Rejected**
- **Plain Docker** (runc): the shared host kernel is not an acceptable boundary for untrusted builds.
- **Kata**: supported as an alternative where customers already run it, not the default.

## 7. Model routing

**FACT**
- vLLM [S165] and Ollama [S166] expose OpenAI-compatible APIs.
- OpenRouter offers provider routing, fallbacks [S167] and ZDR routing [S168].
- Bedrock [S162] and Azure [S163] are enterprise BYO targets.

**PROPOSAL**
- An `LLMProvider` interface (chat, tools, JSON output, embeddings). The OpenAI-compatible adapter covers OpenRouter, Azure OpenAI, vLLM and Ollama; a Bedrock adapter is added.
- **Tiers:** `small` (summaries, dedup), `medium` (verifier), `large` (cross-file and security triage), `embed`. Per-tenant config maps each tier to a list of `provider:model` entries.
- **Budget:** a per-PR and per-tenant monthly token budget. When exhausted, degrade to cheaper tiers in order, then skip optional passes. Never silently drop security triage; mark the review "partial" instead.
- **Fallback:** on 5xx, 429 or timeout, retry the next entry in the tier list with jittered backoff. Circuit-breaker per provider.
- Every call is traced with model ID, tokens and cost (OpenTelemetry).

**Rejected**
- **Single-vendor SDK**: blocks BYO and air-gap.
- **LangChain as core**: abstraction churn; we need a ~300-line adapter, not a framework.

## 8. Multi-tenancy

**PROPOSAL** (detailed in doc 06 §5; FACT basis [S169][S170][S171])
- RLS keyed by `tenant_id` with `FORCE ROW LEVEL SECURITY`, a non-owner app role, and `SET LOCAL` per transaction.
- Per-tenant DEK wrapped by a KMS KEK. Crypto-shredding on offboarding.
- Per-tenant prefixes for BullMQ queues (heavy tenants) and object storage.

**Rejected**
- **DB-per-tenant as the default**: operational overhead at SaaS scale. It remains available as the "dedicated" tier.
- **Schema-per-tenant**: migration fan-out pain with no stronger guarantee than RLS plus keys.

## 9. Semgrep OSS + LLM triage

**FACT**
- Semgrep CE is LGPL-2.1, supports many languages, and uses source-like patterns [S121][S120].
- LLM-assisted static analysis outperforms either approach alone in IRIS [S124].
- LLM-only detection is unreliable [S125].

**PROPOSAL**
- Semgrep is deterministic, reproducible and embeddable (CLI, offline rules), and its licence allows redistribution in self-host images.
- The LLM handles triage, explanation and repo-specific rule synthesis (doc 03).

**Rejected**
- **Bundling CodeQL**: likely licence restrictions for closed-source code (unverified; see doc 03 §3); we accept SARIF import instead.
- **LLM-only**: [S125].

## 10. Vitest and OpenTelemetry

**FACT**
- Vitest is a Vite-native test framework [S189].
- OpenTelemetry JS provides traces, metrics and logs for Node.js [S190].
- BullMQ has a telemetry integration [S185].

**PROPOSAL**
- **Vitest**: fast, native ESM and TypeScript, Jest-compatible API. It also runs the eval harness (doc 05) and the RLS isolation tests (doc 06).
- **OpenTelemetry**: vendor-neutral, required for self-host, where customers bring their own collector. A single trace spans webhook → queue → workers → LLM calls → PR comment. Code and prompt text are never written to span attributes (doc 06 §6).

**Rejected**
- **Jest**: ESM and TypeScript friction.
- **Vendor APM agents**: lock-in, and they cannot run air-gapped.
