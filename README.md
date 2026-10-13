# review

Backend and TypeScript SDKs for an AI code-review and security platform (Greptile/CodeRabbit class). No UI: an API, workers, and SDKs.

- Spec: [docs/PLAN.md](docs/PLAN.md), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/adr/](docs/adr/README.md)
- What works today and what is stubbed: [docs/IMPLEMENTATION-STATUS.md](docs/IMPLEMENTATION-STATUS.md)
- SDKs: [docs/SDKS.md](docs/SDKS.md). Public scoring: [docs/SCORING-PUBLIC.md](docs/SCORING-PUBLIC.md)

## Layout

```
packages/  core  db  queue  models  telemetry  crypto  schemas      shared libraries
           client  sdk  scoring-client                               published SDKs
services/  api-gateway  indexer-worker  review-orchestrator  agent-runner  sandbox-runner  scoring-service
           common (@review/service-common: config, health server, worker bootstrap, object store)
scripts/   bench (@review/bench: greptile-50 benchmark harness)
```

## Review engine

With `REVIEW_MIRROR_ROOT=<dir of git mirrors named by repository id>` the orchestrator runs the multi-agent engine
(context pack -> planner -> hypothesis hunters with code tools -> grounded verifier; see [GREPTILE-GAP](docs/research/GREPTILE-GAP.md)).
Tiers come from env: `MODEL_PROVIDER` (e.g. `gateway` with `GATEWAY_BASE_URL` + `GATEWAY_API_KEY[_FILE]`), `MODEL_SMALL`, `MODEL_MEDIUM`, `MODEL_LARGE`
and optional `MODEL_<TIER>_PRICE="in,out"`. `REVIEW_EXECUTION=1` adds E0-E3 execution checks in the sandbox driver.
`MODEL_REASONING=off|low|medium|high` sets the provider reasoning field; use `off` for DeepSeek V4.1 Flash, which otherwise spends its output budget on hidden reasoning and returns no tool call.
`REVIEW_SEMGREP=1` runs semgrep before any LLM call; it requires `SEMGREP_RULES` to be an absolute path to rules inside the semgrep image (the sandbox has no network).

## Benchmark (greptile-50)

```sh
node scripts/bench/extract.ts                                   # refresh dataset from the public forks (GH_TOKEN)
node scripts/bench/run.ts --repo sentry --mirrors <dir> --out bench-runs/x   # engine under test; model env as above
node scripts/bench/judge.ts --run bench-runs/x                  # published "caught" rule; LLM judge on MODEL_LARGE
node scripts/bench/report.ts --run bench-runs/x                 # catch rate + latency p50/p95, per-phase, LLM calls, cache hit ratio, SLO verdict
```

Latency (see [LATENCY-PLAN](docs/research/LATENCY-PLAN.md)): measure the SLO (p50 <= 150 s, p95 <= 300 s) with `--concurrency 1 --warm`.
Latest live Sentry run (DeepSeek V4.1 Flash on every tier, reasoning off): 4/10 caught, p50 68 s, p95 239 s, $0.10 per PR median; see [IMPLEMENTATION-STATUS](docs/IMPLEMENTATION-STATUS.md#live-sentry-10-case-runs).
`report.ts --input-usd-per-mtok <price>` adds the input cost saved by prompt caching.
`--warm` warms the standing index off the clock, as a push would in production. Engine knobs: `reviewDepth: "auto"` picks fast/standard/deep from PR size and risk.
Prompt caching is on for OpenRouter (`PROMPT_CACHE=0` turns it off) and opt-in for gateways (`GATEWAY_PROMPT_CACHE=1`).
`REVIEW_REMOTE_TEMPLATE=https://github.com/{repo}.git` lets the orchestrator create partial mirrors on first use.

## Quick start

Requires Node 24 and pnpm 10 (via corepack).

```sh
pnpm install
pnpm -r build                      # tsc --noEmit in every package
pnpm -r test                       # Vitest; PGlite runs Postgres in-process, so no services are needed

docker compose up -d               # postgres16+pgvector, valkey, S3-compatible objectstore, otel-collector
RLS_DATABASE_URL=postgres://review:review@localhost:5432/review pnpm --filter @review/db test   # RLS suite on real Postgres
MIGRATION_DATABASE_URL=postgres://review:review@localhost:5432/review APP_DB_PASSWORD=review_app pnpm db:migrate
```

Run a service (sources run directly under Node's type stripping). Each one serves `/healthz` and `/readyz` on `PORT`:

```sh
cp .env.example .env               # throwaway local values; then export them
PORT=8080 node services/api-gateway/src/main.ts
PORT=8081 LOCAL_KMS_MASTER_KEY_FILE=/path/to/32-byte-base64 node services/indexer-worker/src/main.ts
```

`RUNTIME_MODE=memory` boots any service without Postgres, Valkey or the object store, for smoke tests.

## Security notes

- Every tenant table has RLS enabled and forced. Services connect as `review_app`, which has no BYPASSRLS, and touch data only through `withTenant`.
- Secrets come from env vars or `*_FILE` paths and are never committed or logged. Logs and spans are redacted: no code, diffs, prompts, or tokens.
- A live model check is opt-in: `OPENROUTER_API_KEY_FILE=... node scripts/validate-model.ts` (see [docs/VALIDATION.md](docs/VALIDATION.md)).
