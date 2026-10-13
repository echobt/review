# Validation: end-to-end model routing with OpenRouter

Purpose: prove that the real routing path works with `deepseek/deepseek-v4.1-flash` on OpenRouter. The path is `ModelRouter` (`packages/models/src/router.ts`) with the OpenAI-compatible provider calling the OpenAI-compatible `/chat/completions` endpoint, with a forced tool call, and the reply parsed with the zod `Finding` schema from `@review/core`.

## Secrets
- Provide the key as `OPENROUTER_API_KEY`, or point `OPENROUTER_API_KEY_FILE` at a private file (chmod 600, outside the repo).
- `.gitignore` excludes `.env*`, `*.key`, and `secrets/`. The harness never prints the key.

## Run
```sh
pnpm install
OPENROUTER_API_KEY_FILE=~/.secrets/openrouter.key pnpm validate:model
# or: node scripts/validate-model.ts
```
Exit codes: `0` PASS, `1` FAIL, `2` SKIPPED (no key). Spend is capped at $0.05 by the router budget, and one call is about 1k tokens.

## What it asserts
1. The router resolves tier `small` (ADR cheap tier) to `openrouter` / `deepseek/deepseek-v4.1-flash` (override with `VALIDATE_MODEL`).
2. The model answers with a `report_findings` **tool call**, not free text.
3. The tool arguments parse with `z.object({ findings: Finding.omit({id, reviewId}).array().min(1) })`.
4. At least one finding has `category: "security"` on `src/db.ts`. The fixture diff introduces SQL string concatenation (CWE-89).
5. It prints model, provider, latency, tokens, and cost as JSON. The final line is `PASS` or `FAIL`.

## Offline coverage (always runs in `pnpm test`, no spend)
`packages/models/test/router.test.ts` covers jittered retry then fallback on 503, no fallback on 400, skipping providers without a key (401), tier downgrade, per-PR and per-tenant budgets, circuit breaker open/half-open, structured-output repair, and the HTTP adapter.

## Whole-chain smoke (PROPOSAL, phase 2)
`docker compose up -d`, then `POST /v1/reviews` with the same diff. The orchestrator turns that into an `agent.task`, and the agent-runner calls the same `ModelRouter`. Wait for the `finding.created` event, then score it against `docs/scoring/datasets/sample-0.1` case `sample-002` with `@review/scoring-client`.

## Status (FACT, 2026-10-11)
In the build environment, `OPENROUTER_API_KEY` was unset and no key file was found, so the harness exited `2` (SKIPPED). The log is in `logs/validate-model.log` in the job directory. **The live call is still unproven.** Re-run the command above with a key to close this out.

## Status (FACT, 2026-10-11, implementation branch boat/c086bbfcb55e)
Re-run after the router moved to `@review/models`: `node scripts/validate-model.ts` printed `SKIPPED: set OPENROUTER_API_KEY or OPENROUTER_API_KEY_FILE` and exited 2. No key is available on the build host, so the live call is **still unproven**. The whole-chain smoke ran against docker compose without a key: the review reached the agents, every agent failed with `provider not configured (no API key)`, and the review was marked `failed`.
