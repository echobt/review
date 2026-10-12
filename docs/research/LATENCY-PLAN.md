# Latency plan: from ~23 min to <= 2m30s per PR without losing recall

Date: 2026-10-12. Companion data: [LATENCY-PLAN.json](./LATENCY-PLAN.json). Sources: [SOURCES.md](./SOURCES.md) (S200-S218 from GREPTILE-GAP, S220-S233 added for this plan).

Labels used throughout:

- **FACT**: published by a cited source, or read directly from code in this repo (file path given).
- **MEASURED**: observed in our own benchmark runs. Only the totals in §0 are measured. No per-phase measurements exist yet.
- **PROPOSAL**: design, hypothesis or estimate. Unproven until the measurement plan in §8 confirms it.

No number in this document is invented. Every number is one of these: a cited figure, a constant read from code, the measured totals in §0, or arithmetic on those (the inputs are shown). The per-phase budget in §7 is a target, not a prediction.

## 0. Summary

| | |
|---|---|
| Where we are (MEASURED) | 10-case Sentry set, multi-agent engine on base `boat/1da9053f5295`: median ~23 min/PR, max ~62 min, `sentry-01` crashed with a V8 heap OOM at ~78 min. Median cost $2.48/PR. Catch rate 4/10. |
| Where Greptile is (FACT) | "~3 minutes average review time" [S220]. v5 (a parallel swarm of agents, each checking one hypothesis) cut median review time from 5:04 to 2:25 in production A/B tests [S204][S205]. The repo graph is built once: "3-5 minutes for small repositories, and over an hour for bigger ones, but you only need to do this once"; the index "auto-updates on every push" [S221]. Copilot code review "usually takes less than 30 seconds" [S222]. It gathers project context on demand through GitHub Actions [S223]. |
| Root cause (PROPOSAL, reasoned from code in §1) | Wall time is dominated by **serialized LLM round-trips**, not by indexing or clone. Worst case, the critical path is about **42 sequential LLM calls** (§1.2). Three things make each call slow and expensive: (a) prompts of up to ~50k tokens, (b) **zero prompt caching**, because a random nonce sits at the start of every system prompt, and (c) tool calls that each run `git grep` over the whole repo, one after another. The heap OOM most likely comes from unbounded per-commit file/parse caches (§1.1, H8). |
| Plan (PROPOSAL) | 1) Measure per phase (§8) before changing anything. 2) Cut critical-path depth: run hunters and verifiers as one streamed pool with a wider, tier-capped width, and cap tool rounds (§3). 3) Turn on prompt caching: one nonce per review, a stable shared prefix, `cache_control` (§4). 4) Serve tools from a standing Postgres index instead of `git grep` (§2, §6). 5) Run deterministic checks first and in parallel, off the LLM critical path (§5). 6) Auto-tier by PR size (§5). |
| Recall guard | Every change is scheduling, caching or storage. Hypothesis caps, context pack contents, verifier grounding and E0-E3 stay unchanged. Exit criteria (§8.3) require catch rate >= the current 4/10 on the same cases, at no higher median cost. |

## 1. Where the 23 minutes go

### 1.1 Review path as implemented (FACT, from code)

Multi-agent path (`runReview` -> `multiAgent` in `services/review-orchestrator/src/orchestrator.ts`):

| # | Step | Code | Concurrency today |
|---|---|---|---|
| 1 | Index lookup: `ensureIndexed(repo, headSha)` | `services/review-orchestrator/src/pack.ts` `gitMirrorIndexer`: `git cat-file -e`. If the commit is missing: `git fetch --depth=1 origin <sha>` (timeout 600 s). Returns a **new in-memory `LocalCodeIndex`** (`services/indexer-worker/src/local-index.ts`). | Sequential |
| 2 | Context pack | `buildContextPack` (`pack.ts`): parse changed files, then 7 sections via `Promise.all` (files, definitions, classes, callers, imports, rules, versions), then `related` (`ix.search`). Every definitions/references lookup runs `git grep` over the whole tree at `headSha` (`gitRepoSource.grep`, `services/indexer-worker/src/indexer.ts`). The class section does up to 2 sequential `definitionsMany` rounds per changed class. | Partly parallel |
| 3 | Planner | `planHypotheses` (`services/review-orchestrator/src/review.ts`): one `router.json` call on tier `small`. Up to 2 rounds if the output fails validation (`ModelRouter.json`, `packages/models/src/router.ts`). | Sequential, blocks step 4 |
| 4 | Hunters | `runPipeline`: one task per hypothesis (cap `HYPOTHESIS_CAP` = 8/20/40 for fast/standard/deep) plus one free hunt per file group (`fileGroups`: <= 6 files / 2,000 added lines). `pool(tasks, width = 6)`. Each hunter is an `agentLoop` with up to `maxToolRounds = 4` chat calls, then a forced `router.json` (up to 2 more calls). `maxTokens: 4000` per call. Hunter prompt = `renderPack` focus at **40k-token budget** plus diff <= 40k chars. | 6 wide |
| 5 | Tool calls inside a round | `agentLoop`: up to 6 tool calls per round, executed in a **`for` loop with `await`**, i.e. sequentially. Each call does a full-repo `git grep` (definitions/references/search) or a blob read. | **Sequential** |
| 6 | Barrier | All hunters must finish before verification starts (`await pool(...)`, then dedupe). | Barrier |
| 7 | Verifier | `verify`: one per unique candidate with confidence >= 0.3, up to `cap + 10` (30 on standard). `agentLoop` on tier `large`, up to 3 rounds plus the forced JSON. Prompt = 80-line excerpt plus `renderPack` at 20k tokens. After the loop it runs `renderPack(pack, { tokenBudget: 200_000 })` for grounding, plus up to 4 more `definitions` greps. | 6 wide |
| 8 | Execution E0-E3 (when `REVIEW_EXECUTION=1`) | `validateExecution` (`services/sandbox-runner/src/execution.ts`): runs E0, E1, E2, then E3 commands **one after another**. Each is a fresh `docker run --rm --runtime=runsc` (`services/sandbox-runner/src/sandbox.ts`). Timeouts are 180 s (E0/E1) and 600 s (E2/E3) **per command**. It starts only after the verifier. | Sequential, after LLM |
| 9 | Summary | `deps.executor(... kind: "summarizer")`, one more `router.json` on `small` (`services/agent-runner/src/agent.ts`). | Sequential |
| 10 | Post | GitHub review and check run, DB writes, queue events. | Sequential |

Retry behavior (FACT, `packages/models/src/router.ts`, `provider.ts`): `retry.attempts = 2`, full-jitter backoff up to 4 s, a **120 s timeout per HTTP call**. On failure the router falls through to the tier's fallback chain and then **downgrades** (large -> medium -> small). One hung provider can therefore cost 120 s x 2 attempts per target before downgrading.

What exists for measurement (FACT): `packages/telemetry` provides `withSpan`. `services/common/src/runtime.ts` wraps each queue job in **one** span (`<queue> process`). Nothing inside the review is spanned. `runReview` emits `log` events (`pack`, `plan`, `tool`, `verdict`, `error`, `execution`), and `scripts/bench/run.ts` stamps them with `t` (ms since case start) into `<case>.events.jsonl`. The router records `latencyMs` per attempt (`Attempt`), but `review.ts`'s `add()` drops it. Only token counts and cost survive. `scripts/bench/report.ts` reports `latencyS.median` and `max`; there is no p95 and no per-phase breakdown.

### 1.2 Critical-path arithmetic (PROPOSAL; inputs are code constants)

At `reviewDepth = standard` with 20 hypotheses and ~2 free-hunt groups there are 22 hunter tasks. With `width = 6` that is ceil(22/6) = **4 waves**. In the worst case each wave lasts as long as its slowest task: 4 tool rounds + 1 forced JSON = 5 sequential calls. That gives 20 sequential hunter calls. Verifiers: up to 30 candidates, ceil(30/6) = 5 waves x (3 + 1) = 20 calls. Add planner (1) and summarizer (1): **~42 sequential LLM calls** worst case, with the waves strictly ordered by the barrier.

Measured median: 23 min = 1,380 s. 1,380 s / 42 ≈ 33 s per call on the critical path. That is in a plausible range for prompts of ~40-50k tokens with up to 4,000 output tokens on standard/frontier models. It has **not been measured** (§8 does that). The 62 min maximum fits larger diffs (more hypotheses and candidates), downgrade/retry chains, or E2/E3 sandbox runs (up to 600 s each, sequential).

### 1.3 Hypotheses per suspected cost center

| ID | Hypothesis (PROPOSAL) | Evidence in code (FACT) | How to measure (span / event to add) | Expected share |
|---|---|---|---|---|
| H1 | **Serialized LLM depth** (planner -> 4 hunter waves -> barrier -> 5 verifier waves -> summarizer) dominates | `runPipeline`, `pool(…, 6)`, `agentLoop` rounds, `HYPOTHESIS_CAP` | span `review.pipeline.{plan,hunt,verify}` + per-task span `review.hunt.task`; attribute `rounds` | Largest |
| H2 | **Per-call LLM latency** is high because prompts are large (40k-token pack + diff per hunter) and output reaches 4,000 tokens | `renderPack(…, 40_000)`, `maxTokens: 4000` | span `llm.call` with GenAI attributes (model, input/output tokens, cached tokens, latency) [S233] | Large |
| H3 | **No prompt caching**: every agent's system prompt starts with a fresh random fence (`fenced()` → `UNTRUSTED-<random>` inside `SYSTEM_BASE`), so no two agents share a prefix; `ChatMessage.content` is a plain string, so no `cache_control` can be sent | `review.ts` `fenced`, `SYSTEM_BASE`; `packages/models/src/provider.ts` `ChatMessage` | `usage.prompt_tokens_details.cached_tokens` from OpenRouter [S225]; today parsed as absent | Multiplies H2 |
| H4 | **Tool calls run sequentially**, each a full-repo `git grep` on a large repo (Sentry) | `agentLoop` `for (const c of calls) await runTool`; `LocalCodeIndex.grep` -> `git grep` | span `tool.<name>` with `hits`, `ms` | Medium |
| H5 | **Retries / downgrade** inflate the tail (120 s timeout, 2 attempts, fallback + downgrade) | `router.ts`, `provider.ts` | `Attempt[]` per call (already built), persisted into events | Tail (p95) |
| H6 | **Execution checks** are sequential, cold `docker run` per command, up to 180/600 s | `validateExecution`, `sandboxExecutor`, `gvisorArgv` | span `exec.<level>.<label>` | Only when enabled; tail |
| H7 | Index lookup / fetch / pack build are small on the bench (mirrors pre-cloned) but grow with repo size | `gitMirrorIndexer` (fetch only when missing), `buildContextPack` (`stats.buildMs` already recorded) | `pack` event `buildMs` (exists); span `index.ensure` | Small on bench |
| H8 | **Heap OOM**: `LocalCodeIndex` caches every file text and parse tree it touches in unbounded `Map`s; `gitMirrorIndexer` keeps every `repo@sha` index forever; the bench runs 2 cases concurrently in one process; the verifier renders a 200k-token pack per candidate | `local-index.ts` `#text`/`#parsed`, `pack.ts` `cache`, `run.ts --concurrency 2`, `verify()` | `process.memoryUsage().heapUsed` sampled into events every 10 s | Causes the crash, not the median |
| H9 | Clone per run | Not the case on the review path: `gitMirrorIndexer` reuses `<root>/<repo>` mirrors and only fetches a missing head commit with `--depth=1`; `scripts/bench/run.ts` fetches `--depth=50` when missing | span `index.ensure` with `fetched: bool` | Small |

## 2. Persistent repository index

### 2.1 What exists (FACT)

- **Postgres schema** (`packages/db/src/migrations.ts`): `repo_indexes` (`commit_sha`, `status`, `base_index_id`), `index_files` (`path`, `blob_sha`), `symbols`, `symbol_edges`, `chunks` (with `embedding` vector, HNSW `chunks_embedding_hnsw`, GIN `chunks_tsv`), and `embedding_cache` (PK `tenant_id, model, content_hash`). All of them are in `TENANT_TABLES`, so each gets `ENABLE` + `FORCE ROW LEVEL SECURITY` and a `tenant_isolation` policy on `app.tenant_id` (`packages/db/src/rls.ts`, ADR 0007, [S231]).
- **Incremental builder** (`services/indexer-worker/src/indexer.ts`, `indexRepository`/`build`): unchanged `(path, blob_sha)` pairs are reused from the base index, and only changed blobs are parsed, chunked and embedded. Embeddings are cached by `content_hash`. Hybrid retrieval with RRF exists (`services/indexer-worker/src/retrieval.ts`).
- **Gaps**:
  1. The review path never uses it. `main.ts` wires `gitMirrorIndexer`, which uses the grep-based `LocalCodeIndex`. There is no `CodeIndex` implementation backed by Postgres.
  2. Indexing is triggered only by the API (`services/api-gateway/src/app.ts` enqueues `index.requested`), not by push webhooks.
  3. "Reuse" **copies** every unchanged row into the new index (`copyFromBase`: `INSERT … SELECT` of symbols, edges and chunks), so each push costs O(repo), not O(change).
  4. Rows are inserted one statement at a time in loops.
  5. Name-only call resolution (`ponytail` comment in `build`).

### 2.2 Design (PROPOSAL)

**Shape: content-addressed blobs + per-branch manifest + PR overlay.**

1. **Content-addressed facts.** Key `symbols`, `symbol_edges` and `chunks` by `(tenant_id, blob_sha)` instead of `index_id`. Facts parsed from a blob never change, so they are written once per tenant and never copied. Moved blobs are the exception: `fq_name` embeds the path (comment in `build`), so key by `(blob_sha, path)` or store path-free names and join the path from the manifest. Migration: add `blob_sha` lookup indexes, then drop the `index_id` FK in a later step.
2. **Manifest per `repo@branch`.** `index_files(index_id, path, blob_sha)` stays as the per-commit manifest (paths x blobs only, a few columns per file). New table `branch_heads(tenant_id, repository_id, branch, index_id, commit_sha, updated_at)` points at the latest ready manifest. Add `branch_heads` to `TENANT_TABLES` so RLS applies.
3. **Update on push** (off the critical path). A webhook `push` event on a tracked branch enqueues `index.requested { mode: "incremental" }`. The indexer runs `git ls-tree` -> diffs `(path, blob_sha)` against the current manifest -> parses/embeds **only new blob SHAs not already present for the tenant** -> writes the new manifest -> swaps `branch_heads` in one transaction. Update cost = O(changed blobs) parse + embed (embedding cache hit for identical content) + O(files) manifest rows. Replace the per-row `INSERT` loops with batched multi-row `INSERT … SELECT unnest(...)` (or `COPY`).
4. **Cold start.** The first index of a repo runs as a background job when the repo is enabled. Greptile documents "over an hour for bigger" repos, once [S221]. Until it is ready, reviews use the current `LocalCodeIndex` fallback (`ensureIndexed` keeps working), so first-PR latency degrades gracefully instead of blocking.
5. **Orchestrator lookup.** `IndexerPort.ensureIndexed(repo, headSha)` becomes:
   `branch_heads(repo, pr.baseRef)` -> base manifest (ready) + **PR overlay**: files changed in the diff are read at `headSha` (from the mirror or GitHub contents), then parsed in-process (the same `parseSource` that `buildContextPack` already calls for changed files). `PgCodeIndex implements CodeIndex`: `definitions/references/search` query `symbols`/`symbol_edges`/`chunks` joined to the base manifest, **minus overlay paths, plus overlay parse results**. `readFile` serves blobs from the object store (`index_files.object_key`, already written encrypted by `build`). Warm reviews never rebuild anything.
6. **Isolation.** All queries run inside `withTenant` (`SET LOCAL app.tenant_id`), which is the existing pattern. With FORCE RLS even the table owner cannot read across tenants [S231]. For ANN with filters, use pgvector iterative scans / partial indexes so the tenant/manifest filter does not starve HNSW results [S232]. Blobs stay envelope-encrypted per tenant (`cipher.encrypt(tenantId, …)`, already the case).
7. **Invalidation.** Blob facts are immutable, so they are never invalidated. Manifests are immutable per commit. Only `branch_heads` moves. GC: delete manifests older than N commits per branch, and delete blob facts with no manifest reference (periodic job). Changing the embedding model invalidates `embedding_cache` by its `model` column (already keyed).
8. **Recall parity.** `PgCodeIndex` must return the same definitions/references as `LocalCodeIndex` for the bench cases. Gate: for each bench case, diff the context pack built by both (`ContextPack.stats.resolved`, definitions set) before switching (§8.3).

Expected effect (PROPOSAL): tool calls change from full-repo `git grep` (seconds on large repos, unmeasured) to indexed SQL lookups (`symbols_name` B-tree, GIN tsv, HNSW). This shortens H4 and part of H7. It does **not** fix H1-H3, which dominate.

## 3. Parallelism

### 3.1 Evidence (FACT)

- Greptile v5: "spins up a swarm of agents that each explore one hypothesis… Since these agents run in parallel, our end to end latency is much smaller". Median 5:04 -> 2:25 [S204][S205].
- Anthropic's multi-agent research system: the lead agent spawns 3-5 subagents in parallel, and subagents use 3+ tools in parallel, which "cut research time by up to 90% for complex queries". The trade-off: multi-agent systems use about 15x more tokens than chats, and token usage explains 80% of the performance variance in their eval [S227].
- Claude may call multiple tools in one response by default; it can be disabled with `disable_parallel_tool_use` [S228]. Our `agentLoop` already accepts up to 6 tool calls per round, but **executes them sequentially**.

### 3.2 Design (PROPOSAL)

1. **Parallel tool execution**: `await Promise.all(calls.map(c => runTool(...)))` in `agentLoop`, and keep result order. A one-line change; it removes H4's serialization.
2. **Streamed hunt -> verify, no barrier**: start `verify(c)` as soon as a hunter yields a candidate that passes the diff-anchor and dedupe check, using one shared bounded pool. Dedupe becomes incremental: the `seen` key is checked at enqueue time, and the confidence sort is replaced by a min-confidence threshold (the existing `verifyThreshold = 0.3`). Critical path = planner + max(hunter) + max(verifier on its candidates) instead of the sum of the waves.
3. **Width by tier** (cap): `concurrency` per review = min(tasks, tier cap). Proposed caps: fast 8, standard 16, deep 24. All hypotheses of a standard review then run in about 2 waves instead of 4. The cap must also respect the provider rate limit per key. The bench runs 2 cases concurrently against the same key (`run.ts --concurrency`), so the bench must measure single-case latency separately (§8).
4. **Fewer rounds per agent**: allow `report_findings` in round 1 (already allowed). Cap hunter rounds at 3 and verifier rounds at 2, but **only if** the bench shows no catch-rate loss. `maxToolRounds` is already a `PipelineDeps` knob.
5. **Planner off the critical path for the free hunt**: start free-hunt tasks (`fileGroups`) at time 0, concurrently with the planner. They do not depend on hypotheses.
6. **Pack sections in parallel**: `buildContextPack` already uses `Promise.all` for 7 sections. `related` waits on `classes`. The `classes` section loops sequentially over classes; switch to `Promise.all` per class.
7. **Execution checks in parallel and earlier**: E0/E1 do not depend on the LLM. Start them right after `ensureIndexed`, in parallel with the planner (one sandbox per language command, `Promise.all`). E2 depends only on `pack.callers`, so start it after the pack. E3 depends on hunter tests and stays after the hunters. Execution findings already merge by location (`twin` logic), so ordering does not affect results.
8. **Stream partial results**: post the check run as `in_progress` at start, and post verified findings as they land (or batch at about 60 s). The final summary comes last. This improves perceived latency, not the SLO metric (§8 measures time to final review).

Trade-off: more width means the same token count and cost, finished sooner. Cost is unchanged by scheduling. Rate-limit 429s turn into retries (H5), so width needs a per-provider semaphore in `ModelRouter`.

## 4. Prompt and context caching

### 4.1 Evidence (FACT)

- Anthropic: the cache covers the full prefix in the order `tools` -> `system` -> `messages`, up to the `cache_control` block. Default TTL is 5 min, refreshed on each hit; 1 h is available at extra cost. Pricing multipliers: 5-min write 1.25x base input, 1-h write 2x, **read 0.1x** (some newer models lower). Up to 4 breakpoints. A change at one level invalidates that level and everything after it [S224].
- OpenRouter: most providers cache automatically (OpenAI, DeepSeek, Gemini 2.5). Anthropic needs `cache_control` on content blocks. OpenRouter uses **provider sticky routing** to keep caches warm, keyed by `session_id` / `x-session-id`, falling back to `prompt_cache_key`. Cache usage appears in `usage.prompt_tokens_details` (cached tokens, cache write tokens) [S225].
- OpenAI (GPT-5.6+): minimum cacheable prompt 1,024 tokens. Write 1.25x, read 0.1x on most models. "Across ten requests, one write and nine full reads cost 2.15× at that rate, compared with 10× without caching" [S226].
- Our defaults (FACT, `packages/models/src/router.ts` `DEFAULT_TIER_MODELS`): small `deepseek/deepseek-v4.1-flash` ($0.1 / $0.4 per MTok), medium `anthropic/claude-sonnet-4.5` ($3 / $15), large `openai/gpt-5` ($1.25 / $10). The medium tier, which runs all hunters, is Anthropic and therefore **needs explicit `cache_control`**.

### 4.2 Why we get ~0% cache hits today (FACT, from code)

1. `fenced()` makes a fresh `UNTRUSTED-<12 hex>` nonce per agent call site, and `SYSTEM_BASE(fence)` puts it in the **system** prompt. Every hunter and verifier therefore has a unique prefix after the tools block. The tools block (`AGENT_TOOLS` + the final tool) is identical per role, so a provider could at most cache the tools.
2. The hunter system prompt also embeds `KIND_HINT[kind]`, `addendaFor(files)` and `versionNote`, so it differs per hypothesis.
3. `ChatMessage.content` is a `string` and the provider sends it as-is, so there is no way to attach `cache_control` and no `session_id` / `prompt_cache_key`.
4. `provider.ts` parses `usage.prompt_tokens` / `completion_tokens` / `cost` only, so cached tokens are invisible.

### 4.3 Design (PROPOSAL)

Prompt layout per review, most stable first:

1. `tools` (identical per role) — breakpoint 1.
2. `system`: role text + **one nonce per review** (still unpredictable to repo content, which is fixed before the review starts, so the injection defense holds) + `versionNote` + repo rules (`pack.rules`) — breakpoint 2.
3. `user[0]`: **shared review context** = `renderPack(pack, { tokenBudget: N })` without focus + full diff, identical for every hunter of this review — breakpoint 3.
4. `user[1]`: the per-task part (hypothesis, kind hint, `addendaFor(task.files)`, focus files). Keep it small; it is not cached.
5. Loop turns (tool results) append after it. Implicit/automatic caching covers the growing conversation within one agent loop.

Changes: let `ChatMessage.content` also take content blocks with `cache_control` (OpenRouter passes these through to Anthropic [S225]); send `session_id = reviewId` for sticky routing; parse `prompt_tokens_details`; record `cachedTokens` in `Usage` and the events.

Across PRs: the repo-rules + tools + role prefix is stable per repo, so a 1-h TTL write (2x) pays off only if the same repo sees reviews within the hour. Default to the 5-min TTL. Embeddings are already cached per `(tenant, model, content_hash)` (`embedding_cache`); keep that.

### 4.4 Expected savings (PROPOSAL; arithmetic on cited multipliers and code constants)

Let P be the shared prefix, in tokens, read by N calls within the TTL. Input-token cost relative to no caching: (1.25 + 0.1·(N−1)) / N.

| Case | P (tokens) | N | Relative input cost of the prefix | Saving |
|---|---|---|---|---|
| One hunter loop (round 1 writes, rounds 2-4 read) | ~40k (pack budget) | 4 | (1.25+0.3)/4 = 0.39 | 61% |
| Shared review context across 22 hunters x ~4 rounds | ~40k | 88 | (1.25+8.7)/88 = 0.11 | 89% |
| OpenAI worked example [S226] | – | 10 | 2.15/10 | 78.5% |

Cost: input tokens dominate hunter and verifier calls (40k-token prompts vs <= 4k output). The measured median of $2.48/PR should therefore drop. The exact figure needs the per-call token split from §8; it is not claimed here. Latency: Anthropic states caching "significantly reduces processing time" [S224] but publishes no number we can apply. Treat the latency gain as unquantified until §8 measures time-to-first-token with and without cache hits.

## 5. Cheap path first, and auto-tiering

### 5.1 Evidence (FACT)

- Greptile review tiers: "Higher tiers take longer, catch more, and cost more"; **Auto** "picks a tier for each PR from its size, risk, and complexity" [S211].
- Our E0-E3 (`services/sandbox-runner/src/execution.ts`) already exist and produce diff-anchored findings at confidence 0.9. Today they run **after** the LLM pipeline and only enrich it. Semgrep wiring exists in `services/sandbox-runner/src/semgrep.ts`, but it is not called from the review path.
- Import existence is already computed deterministically in the pack (`resolveImports` -> `ImportNote.status = "missing"`), and the pack passes it to hunters as a fact.

### 5.2 Design (PROPOSAL)

1. **Deterministic stage, started at t≈0, in parallel:** E0 (compile/type) + E1 (import smoke) + semgrep on changed files + pack-level `missing` imports. Each tool gets its own sandbox command via `Promise.all`. Budget 20 s wall; anything slower is reported late and does not block (§7).
2. **Escalate only what survives:** a deterministic finding at a location (+/-3 lines) becomes a **pre-verified** finding (`source: "hybrid"`, like today's `twin` logic). The planner gets those locations as "already found" so it does not spend hypotheses on them. It must **not** skip the hunk; other bugs may sit in the same hunk (recall guard).
3. **Tier routing (exists, keep):** planner/summarizer `small`, hunters `medium`, verifier `large` (`ROLE_TIER`, `DEFAULT_TIER`). Dedupe is already deterministic (`seen` key), so no LLM is needed.
4. **Auto depth by PR size/risk** (new; mirrors Greptile Auto [S211]): choose `reviewDepth` and the width cap from deterministic features: added lines, changed code files, security-sensitive paths, and whether any deterministic check failed. Proposed thresholds, to be calibrated on the 50-case set: <= 200 added lines and <= 5 files -> `fast` (cap 8); otherwise `standard`; security paths or > 2,000 lines -> `deep`. Tenant `reviewDepth` remains an override.
5. **Verifier skip for deterministic-confirmed findings:** findings confirmed by E0/E1/E3 (confidence 0.9, command evidence) do not need a frontier verifier call. This saves one `large` call each.

## 6. Repo access

FACT: the review path does **not** clone per run. `gitMirrorIndexer` uses existing mirrors under `REVIEW_MIRROR_ROOT/<repo>` and fetches a missing head commit with `--depth=1`. E0-E3 use `gitWorktree` (`git worktree add --detach`) under `SANDBOX_WORKSPACE_ROOT`, and it is reused when present. The indexer reads blobs via `git cat-file` from `REPO_MIRROR_DIR`. Gaps: worktrees are never pruned; `--depth=1` fetches into a full mirror can make the mirror shallow; there is no per-(repo, branch) cache policy for job VMs.

PROPOSAL:

1. **One bare partial mirror per repo per worker host**: `git clone --bare --filter=blob:none` [S229]. Commits and trees come up front; blobs are fetched on demand from the promisor remote. That is enough for `ls-tree`, diffs and worktrees. Fetch on webhook (`git fetch origin <ref>`) so the head commit is usually present before the review job starts.
2. **Worktree per review, removed after**: `git worktree add --detach` from the mirror (multiple worktrees share one object store [S230]), then `git worktree remove` in a `finally`. Only E0-E3 need it, and only for the files the sandbox touches.
3. **File reads from the index** (§2): `PgCodeIndex.readFile` serves base-branch blobs from the object store and overlay blobs from the mirror. No network on the hot path once the mirror is warm.
4. **Shared cache for ephemeral VMs**: a read-only mirror volume (or object-store tarball of the bare mirror) per repo, restored at VM boot and refreshed by fetch. Budget 5 s (§7) assumes a warm mirror; a cold restore is off the SLO path, like the cold index.

## 7. Target budget (PROPOSAL)

Standard depth, warm index and mirror, p50 target <= 150 s. "CP" = on the critical path.

| Phase | Budget | CP? | Depends on |
|---|---|---|---|
| Diff fetch + config load | 3 s | yes | – |
| Mirror fetch / checkout of head (warm, partial) | 5 s | yes | §6 |
| Index lookup (`branch_heads` + overlay parse of changed files) | 2 s | yes | §2 |
| Context pack (SQL-backed, parallel sections) | 5 s | yes | §2, §3.6 |
| Deterministic checks E0/E1/semgrep (parallel) | 20 s | **no** (runs in parallel with planner + hunters) | §5 |
| Planner (`small`) | 10 s | yes | – |
| Hunters (all hypotheses + free hunt in <= 2 waves, `medium`, cached prefix, parallel tools) | 60-90 s | yes | §3, §4 |
| Verifier (streamed, starts while hunters run; tail only) | 15 s | yes (tail) | §3.2 |
| E2/E3 tests | up to 600 s timeout each today | **no** for the SLO: post as a follow-up update to the check run | §5 |
| Merge + summary (`small`) + post | 10 s | yes | – |
| **Total CP** | **110-140 s** | | |

Off the critical path entirely: first-ever index (cold start), push-time incremental index, mirror refresh, embedding of new blobs, E2/E3 follow-ups, GC.

Recall caveat: E2/E3 out of the SLO means their findings arrive after the initial review. That changes **when** they are posted, not **whether**. The benchmark catch rate must count the final state, which includes follow-ups (§8.3).

## 8. Measurement plan

### 8.1 Instrumentation (PROPOSAL)

1. **Spans** (OpenTelemetry via `withSpan`, `packages/telemetry`): `review.run` › `index.ensure`, `pack.build` (+ section children; `buildContextPack` already has a `log(phase, ms)` hook via `PackOptions.log` that `multiAgent` does not pass), `pipeline.plan`, `pipeline.hunt.task` (attrs: kind, tier, rounds, tool_calls), `pipeline.verify.task`, `tool.<name>`, `exec.<level>`, `summary`, `post`. One `llm.call` span per router attempt with GenAI semantic-convention attributes (model, input/output tokens, plus cached tokens) [S233]. Keep attribute redaction (`RedactingProcessor`); never put prompt text in spans.
2. **Router hook**: `ModelRouter` takes an optional `onAttempt(attempt, usage)` callback. `review.ts` forwards attempts to `deps.log` as `{ event: "llm", role, tier, model, latencyMs, inTok, outTok, cachedTok, ok }`.
3. **Bench** (`scripts/bench/run.ts`): already writes `t` per event. Add `phase_start`/`phase_end` events (from the same hooks), and heap samples (`process.memoryUsage()`) every 10 s. Add a `--concurrency 1` latency mode, so cases do not compete for the same rate limit.
4. **Report** (`scripts/bench/report.ts`): add `latencyS.p95`, per-phase p50/p95, LLM calls per PR, critical-path depth (max sequential calls), cache hit ratio (cached/input tokens) and peak heap. Unit-test the new aggregations in `scripts/bench/test/bench.test.ts` next to `summarize`.

### 8.2 SLO

- **Latency**: p50 <= 150 s and p95 <= 300 s, wall clock from `review.requested` dequeue to the posted review. Measured on the 10 Sentry cases first, then on the 50-case set, with warm index and mirror, `--concurrency 1`.
- **Cold path** (not in the SLO, reported): first index of each bench repo, and first-PR latency on the `LocalCodeIndex` fallback.

### 8.3 Exit criteria (all must hold on the same case set)

1. Latency SLO above met for 3 consecutive bench runs.
2. Catch rate >= the current 4/10 on Sentry (and, once run, no lower than the multi-agent baseline on the 50-case set). Partial runs are listed separately (`partialCases`, already reported).
3. Median cost/PR <= $2.48 (the current measured median).
4. No OOM. Peak heap below the worker limit on all cases, including `sentry-01`.
5. `PgCodeIndex` parity: for each case, the context pack's resolved definitions match `LocalCodeIndex` (or are a superset).

### 8.4 Order of work (PROPOSAL)

| Step | Change | Targets | Risk to recall |
|---|---|---|---|
| L0 | Instrumentation (§8.1); bench baseline per phase | measurement | none |
| L1 | Parallel tool calls; per-review nonce; content blocks + `cache_control` + `session_id`; parse cached tokens | H3, H4 | none (same prompts, reordered) |
| L2 | Bound the caches (LRU on `#text`/`#parsed`, evict `gitMirrorIndexer` entries per review); no 200k-token render in `verify` (reuse sources) | H8 | none |
| L3 | Streamed hunt->verify, tier width caps, free hunt concurrent with planner, E0/E1 at t≈0 | H1, H6 | low (same tasks) |
| L4 | Auto depth; deterministic-confirmed findings skip the verifier | H1, H2 | medium: calibrate on 50 cases |
| L5 | `PgCodeIndex` + content-addressed facts + push indexing + partial mirrors | H4, H7, H9 | medium: parity gate 8.3.5 |
| L6 | Round caps (3/2) only if the bench shows no loss | H1 | medium |

Re-measure after each step. Keep a step only if it moves its target metric and catch rate does not regress.

## 9. Open questions and limits

- No per-phase data exists. §1's ranking is reasoned from code and must be confirmed by L0 before any optimization claims are made.
- The ~23-min median and the per-call estimate (~33 s) mix provider queueing, model speed and prompt size. Provider-side latency is outside our control; only critical-path depth and prompt size are.
- Greptile's indexing time: the brief says "1-2 hours" for very large repos. The source we could fetch says "over an hour for bigger ones" and "5-50 minutes depending on codebase size" [S221]. We cite the latter.
- Search was rate-limited during this research. Sources were fetched directly (SOURCES.md lists the access method). S221 was read via a search-result excerpt because the page timed out.
