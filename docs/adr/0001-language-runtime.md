# ADR 0001: Language and runtime: TypeScript on Node 24 with pnpm workspaces

- Status: Accepted (PROPOSAL until Phase 0 exit)
- Date: 2026-10-11
- Related: [ARCHITECTURE.md](../ARCHITECTURE.md), [PLAN.md](../PLAN.md)

## Context

Six services (api-gateway, indexer-worker, review-orchestrator, agent-runner, sandbox-runner, scoring-service) share schemas, queue contracts, model-routing and crypto code. Workload is I/O-bound (LLM calls, Git, DB, queue), with CPU hot spots in parsing and diffing. The team is TypeScript-first; LLM SDKs and GitHub tooling (Octokit, Probot ecosystem) are strongest in TS/Python.

## Decision

- TypeScript (strict) on Node 24 LTS for all services; pnpm workspaces monorepo with shared packages (@platform/schemas, db, queue, models, telemetry, crypto).
- Fastify for HTTP; zod as single source of truth for API bodies, queue payloads and LLM structured outputs (JSON Schema derived from zod).
- CPU-heavy work (tree-sitter parsing) runs via native bindings or WASM inside worker_threads; external tools (Semgrep, SCIP indexers, test runners) run in sandbox-runner, so their language is irrelevant.

## Alternatives considered

- **Python (FastAPI + Celery)**: best ML ecosystem, but we do no local training; weaker shared typing between API and workers; would split the team.
- **Go**: excellent concurrency and single binaries; weaker LLM/GitHub SDK ecosystem, more boilerplate for schema-driven structured outputs.
- **Rust**: best performance and safety; slowest iteration speed for prompt- and integration-heavy product work.
- **npm/yarn workspaces, Nx, Turborepo**: pnpm chosen for strict dependency isolation and disk efficiency; Turborepo may be layered on later for caching.

## Consequences

- Positive: one language end to end, shared zod types across HTTP, queues and LLM outputs; fast iteration.
- Negative: single-threaded event loop needs worker_threads for CPU work; native module builds (tree-sitter) must be prebuilt for linux-x64/arm64 and air-gap bundles.
- Revisit if a component becomes CPU-bound beyond worker_threads (candidate: Rust sidecar for indexing).
