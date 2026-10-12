# Greptile gap analysis: what our review engine needs to reach Greptile's benchmark score

Status: research deliverable (2026-10-12). Machine-readable companion: [GREPTILE-GAP.json](./GREPTILE-GAP.json). Sources: [SOURCES.md](./SOURCES.md) (S200–S218 added for this doc; S1xx reused).

Every claim is labelled:

- **FACT**: published by the cited source, or observed by us and reproducible from the job logs.
- **MEASURED**: our own experiment in this job (method and raw output in the job log directory; numbers are small-sample, n=10).
- **PROPOSAL**: our design or estimate. Not proven.

## 0. Summary

| | |
|---|---|
| Target (FACT [S200]) | Greptile 82% overall (41/50); 8/10 on Sentry. Bugbot 58%, Copilot 54%, CodeRabbit 44%, Graphite 6%. |
| Us today (FACT, brief) | 3/10 on Sentry with diff-only, single-pass, single cheap model (deepseek-v4.1-flash). Full 50 never run. |
| Biggest single cause (§6 ablation: INCONCLUSIVE) | Not measured. Model-vs-context ablation (cx/gpt-5.6-sol, diff vs diff+full files) returned only 4/20 results (16 timeouts): diff 1/2 caught (#10 yes, #8 no), ctx 0/2 (#1 no, #8 no). n=2 per arm; no conclusion. Cause ranking in §2 stays PROPOSAL. |
| What to build first (PROPOSAL, §9) | P0 benchmark harness (50 cases, frozen) → P1 "context pack" (full changed files + resolved imports/definitions of every symbol the diff touches) → P2 hypothesis-swarm + tool-grounded verifier → P3 stronger reviewer tier with routing → P4 cheap execution checks (import/compile/type/test) → P5 learning. |
| Exit target (PROPOSAL) | ≥ 8/10 Sentry and ≥ 38/50 (76%) full set by end of P3; ≥ 41/50 (82%) by end of P4, at ≤ $0.50 median model spend per PR. |

## 1. Benchmark reproduction (full 50 PRs)

### 1.1 What Greptile published (FACT [S200])

- 5 OSS repos × 10 bug-fix PRs: Sentry (Python), Cal.com (TypeScript), Grafana (Go), Keycloak (Java), Discourse (Ruby).
- Each PR was traced back to the commit that introduced the bug. Very large and single-file changes were excluded.
- Two branches per case: one before the bug, one after the fix. A fresh PR re-introduced the original change, replicated across 5 clean forks (one per tool). Tools ran hosted, default settings, no custom rules, July 2025.
- **Scoring rule:** caught = an explicit **line-level** PR comment that points to the faulty code **and** explains the impact. Summary-only mentions do not count. False positives and unrelated comments do not affect catch rate.
- Per-repo Greptile catches: Sentry 8, Cal.com 8, Grafana 8, Keycloak 8, Discourse 9 = 41/50.
- The forks are public: `github.com/ai-code-review-evaluation/{sentry,cal.com,grafana,keycloak,discourse}-{greptile,copilot,coderabbit,cursor,graphite}`. FACT (GitHub API, 2026-10-12): `*-greptile` forks hold 10 (sentry, grafana, discourse), 11 (cal.com: PRs 2–11) and 27 (keycloak: extra PRs beyond the 10 benchmarked) pull requests. The case library on [S200] names the exact PR number per case; the harness must take PR numbers from that table, not "PRs 1..10".
- Observation (FACT [S200][S201]): for the same case, PR numbers differ between tool forks (e.g. Sentry "negative offset" is `sentry-greptile#2` but `sentry-copilot#10`). Key cases by bug, not by PR number.
- Observation (FACT [S201]): `sentry-greptile#2` is based on `performance-optimization-baseline` and its diff also contains PR 1's paginator change (9 files). The "negative offset" bug lives in that inherited paginator code. Cases are not fully independent; the harness must use the exact base/head SHAs of each fork PR.

### 1.2 Harness design (PROPOSAL)

Reuse what exists: `docs/scoring/schema/dataset.schema.json` already has `repo`, `baseSha`, `headSha`, `language`, `bugs[]` with `location`, `severity`, `provenance: "real-fix-commit"`; `packages/scoring-client` implements location matching (`lineTolerance: 3`, `maxSpanLines: 10`, rubric v1.0.0). Add a `greptile-50` dataset and a thin runner.

```
scripts/bench/
  extract.ts   # read case table -> for each case, gh api pulls/<n> on <repo>-greptile fork -> base/head SHA, files, patch
  run.ts       # for each case x engine-config: checkout head in a worktree, call runReview(diff, repo@head), write submission.json
  judge.ts     # deterministic match first, LLM judge second, human spot-check file third
  report.ts    # catch rate overall / per repo / per severity, cost, latency; diff vs previous run
```

Dataset record (extends dataset.schema.json; new fields marked +):

```json
{
  "id": "sentry-03",
  "repo": "https://github.com/ai-code-review-evaluation/sentry-greptile",
  "+forkPr": 3,
  "baseSha": "<40 hex>", "headSha": "<40 hex>",
  "language": "python",
  "license": "BUSL-1.1 (Sentry; verify per repo before redistribution)",
  "provenance": "real-fix-commit",
  "+publishedSeverity": "low",
  "+published": {"greptile": true, "copilot": false, "coderabbit": false, "bugbot": false, "graphite": false},
  "bugs": [{
    "id": "sentry-03-b1", "category": "logic", "severity": "low",
    "location": {"path": "src/sentry/testutils/factories.py", "startLine": 353, "endLine": 353},
    "description": "client_sample_rate 0.0 is falsy; `if client_sample_rate:` skips it",
    "+acceptAlso": [{"path": "...", "startLine": 0, "endLine": 0}],
    "+keyTerms": ["sample_rate", "0.0", "falsy", "is not None"]
  }]
}
```

Bug locations: take them from the line comment that the published "✓" tool left on that fork PR (FACT [S201]: e.g. Greptile's `factories.py:353` comment on sentry#3, `flusher.py:199` on sentry#6, `queue_consumer.py:133` on sentry#9, `grouptype.py:11-12` on sentry#10, `organization_auditlogs.py:11` on sentry#1). Where no tool caught a case (Keycloak "Incorrect method call for exit codes"), a human labels the location from the fix commit. `acceptAlso` holds other valid sites (a bug like "shard vs shards" has two lines).

Scoring (mirrors [S200] exactly, then adds what [S200] ignores):

1. **Caught (primary, same rule as Greptile).** A finding is a hit iff (a) it is line-anchored (`path` + line range of ≤ 10 lines), (b) the range is within ±3 lines of a labelled bug location or an `acceptAlso` location, and (c) an LLM judge (fixed frontier model, temperature 0, 3 votes, majority) answers yes to: "Does this comment identify the same defect as `<description>` and explain its impact?". Summary text and PR-level comments never count. Disagreements between judge votes go to a human; the human file is versioned with the run.
2. **Catch rate** = caught / 50, plus per repo and per severity, reported next to the published numbers.
3. **Noise (secondary; not in [S200])**: comments per PR, and judged-valid rate of non-target comments on a 20% sample. Needed because a recall push without it degrades the product (Google calibrates to ~50% precision [S130]).
4. **Cost and latency** per PR from ModelRouter accounting.
5. **Stability**: 3 runs per config (rubric `minRuns: 3`); report mean and min. LLM output varies even at temperature 0.

Run hygiene: the engine sees only `repo@headSha` and `diff(base..head)`; it must not see the fork's existing PR comments, the fix commit, or the case table (leakage). The judge sees the ground truth; the engine never does.

## 2. Why 3/10 vs Greptile 8/10: root cause per miss

FACT from the brief: our engine caught #2 (negative cursor), #7 (mutable default), #8 (stale config). Missed #1, #3, #4, #5, #6, #9, #10. FACT [S200]: Greptile missed #2 and #4 and caught the rest. Diff and comment evidence below is FACT from [S201].

| # | Bug (sev) [S200] | What the evidence shows [S201] | Root cause of our miss | Capability that catches it |
|---|---|---|---|---|
| 1 | Import of non-existent `OptimizedCursorPaginator` (High) | The diff adds `from sentry.api.paginator import DateTimePaginator, OptimizedCursorPaginator`. Greptile's comment: "doesn't exist in the codebase - this import will cause an ImportError". In the fork's head the class is present in `paginator.py` (line 821), so the published "bug" may be a labelling artefact or a branch-ordering issue. | Diff-only: the reviewer cannot check whether an imported name exists. | **Symbol resolution** (import → definition lookup in index), and **execution check** (`python -c "import <module>"` in sandbox). Note: on this head an import check would pass; the case still counts per [S200]. |
| 3 | `sample_rate = 0.0` falsy (Low) | Bug at `factories.py:353`, `if client_sample_rate:`. The PR has 8 files / 480 added lines; the bug is in a test-utility file, not the main module. | Attention/coverage: a single pass over a large diff spends its comment budget on the big new module. Model quality matters too (truthiness-of-zero is a known pattern). | **Per-file/per-hunk hypothesis agents** (every hunk gets attention), plus a cheap **pattern lint** (truthy check on numeric value). |
| 4 | Null ref if `github_authenticated_user` state missing (Critical) | Diff compares `pipeline.fetch_state("github_authenticated_user")` to `integration.metadata["sender"]["login"]`. Greptile also missed it. | Requires knowing that `fetch_state` returns `None` when the key was never bound (cross-file contract) and that `metadata["sender"]` may be absent. | **Cross-file context** (callee definition of `fetch_state`) + a **null-safety hypothesis agent**. Hard for all tools (2/5 caught). |
| 5 | Breaking change in error response format (Critical) | 106-file / 2.3k-line PR. In `browser_reporting_collector.py` the 422 path changes from an empty `HttpResponse(status=422)` to `Response({"error": ..., "details": ...}, 422)`. Greptile's caught comment is not visible in the current fork thread (PR re-reviewed since; 21 comments today). | Diff truncation and budget: 106 files exceed one prompt; the bug is a contract change, not a crash. | **Diff chunking + planner** (route per file group), **API-contract agent** (compares old vs new response shape and searches callers/tests via index). |
| 6 | Metric tag `shard` vs `shards` (Medium) | Greptile: `flusher.py:199` uses `'shards'` while line 185 uses `'shard'` for the same value. Both lines are in the diff. | Pure consistency bug inside the diff. Not a context problem: model attention and prompt (we ask for "bugs", the model treats tag names as style). | **Stronger model** or **dedicated consistency agent**; prompt must say telemetry/key-name mismatches are bugs. |
| 9 | Invalid `queue.ShutDown` handling (High) | Greptile: "standard library `queue` module doesn't have this exception". FACT [S216]: `queue.ShutDown` and `Queue.shutdown()` were added in Python 3.13; Sentry pins 3.13.1 (`.python-version` at base). The code is valid on 3.13. | The miss is likely correct behaviour for 3.13; the benchmark labels it a bug. Catching it requires the model to believe the API is missing. | Version-aware **API existence check** would say "valid on 3.13" (so it would *not* produce the published catch). PROPOSAL: treat as a disputed case; report score with and without it. |
| 10 | Incomplete impl: subclass only `pass` (High) | `class MetricAlertDetectorHandler(StatefulDetectorHandler[...]): pass`. Greptile: the base declares 4 abstract members, so the handler is not instantiable and `Detector.detector_handler` raises `TypeError`. | Diff-only: abstractness of `StatefulDetectorHandler` is defined in another file (`processors/detector.py`). | **Symbol graph**: fetch the base class definition for every changed class; **execution check**: import + instantiate the handler in sandbox (TypeError at runtime). |

Root-cause rollup (PROPOSAL, from the table):

| Root cause | Misses it explains |
|---|---|
| No cross-file / definition context (diff-only) | #1, #4, #5, #10 |
| Single pass, attention spread over large diffs | #3, #5, #6 |
| Model capability on subtle in-diff logic | #3, #6 (ablation attempted in §6; both cases timed out, untested) |
| No execution | #1, #10 (both raise at import/instantiation time) |
| Benchmark label disputed | #9 (and #1 on the current fork head) |

## 3. Repository context / indexing in the review path

### 3.1 Evidence

- FACT [S202]: Greptile builds a graph of the codebase (functions, relationships, dependencies) and uses it during review to see effects of a change elsewhere.
- FACT [S212]: Greptile also keeps a per-repo knowledge base (architecture index, glossary, per-area/flow docs with risk areas) read on every review.
- FACT [S214]: CodeRabbit's context beyond the diff: learnings, code guidelines, multi-repo analysis, MCP servers, web search, linked issues.
- FACT [S110]: a repository code graph improved every SWE-bench method it was added to. FACT [S111]: AST-aware chunking beats line chunking. FACT [S112]: retrievers fail when lexical overlap is low and generators misuse extra context. FACT [S113]: long-context middles are used less reliably.
- FACT (repo): `services/indexer-worker` and `services/review-orchestrator` are 7-line skeletons; ADR 0004 already chose tree-sitter + optional SCIP; the review path does not call the index.

### 3.2 Design (PROPOSAL)

Principle: **deterministic context first, retrieval second.** Most misses need a specific definition, not "similar code". Retrieval is a fallback for intent/convention questions.

Context pack built per PR, in this order, under a token budget (default 60k for the reviewer tier):

1. Full post-change text of every changed source file (not just hunks), truncated around changed symbols for files > 1,500 lines.
2. For every identifier the diff adds or touches: resolved definition (signature + docstring + body up to 80 lines). Resolution: SCIP when available [S217][S218] (scip-python, scip-typescript, scip-java, scip-ruby, scip-go), else tree-sitter tags + import-path resolution (ADR 0004).
3. For every changed class: base classes and their abstract members; for every changed function: its callers (top 10 by graph distance) and the tests that reference it.
4. Imports added by the diff, each annotated `exists | missing | external(version)` (closes #1, flags #9 as version-dependent).
5. Hybrid retrieval (BM25 + vector + graph, RRF; already in [02-context-indexing](./02-context-indexing.md)) for: same-named symbols, sibling implementations (e.g. other `*DetectorHandler` subclasses), and repo rules/knowledge-base pages.

Wiring: orchestrator calls `indexer.ensureIndexed(repo, headSha)` (blob-SHA incremental; full index on first sight), then `contextPack(diff)`. The pack is written once and passed by reference to all agents. Agents also get tools: `get_definition(symbol)`, `find_references(symbol)`, `read_file(path, range)`, `search(query)`. Tools matter because static packs miss what an agent decides to check mid-reasoning (FACT [S135]: interface design drives agent performance).

Measurable gate (PROPOSAL): on the 50 cases, "the labelled bug's required definition is in the pack" ≥ 90% before agents are tuned.

## 4. Multi-agent review that buys recall

### 4.1 Evidence

- FACT [S204][S205]: Greptile v5 runs "a swarm of agents that each explore one hypothesis for a potential bug" in parallel; narrow scope lets each go deeper; v5 raised comments-addressed 52%→66%. FACT [S203]: v4 raised addressed comments per PR 0.92→1.60.
- FACT [S211]: Greptile sells review tiers (1/3/10 credits); higher tiers "take longer, catch more, and cost more"; Auto picks per PR from size, risk, complexity.
- FACT [S133]: multi-agent systems used ~15× the tokens of chat and beat a single agent by 90.2% on Anthropic's internal research eval; most of the variance was explained by tokens spent.
- FACT [S134]: a fixed pipeline (Agentless) beat open-source agents on SWE-bench Lite at $0.70/issue. FACT [S132]: start simple.
- FACT [S128]: intrinsic self-correction is unreliable; FACT [S129]: tool-grounded critique works. FACT [S130]: Google targets ~50% precision for ML review comments.
- FACT [S207]: Greptile found one big agent got overloaded; orchestrator + parallel narrow subagents worked.

### 4.2 Design (PROPOSAL)

```
planner (cheap tier)
  input: diff stats, file list, context pack summary
  output: hypotheses[] = {file, hunk, kind, question}   # 5–40 per PR, capped by tier
          kinds: null-safety, contract/API change, missing-impl/abstract, import/symbol existence,
                 consistency (names, tags, keys), numeric/truthiness, concurrency, security, resource/cleanup
  plus: one "free hunt" agent per file group (catches what the planner did not predict)

hunters (parallel, standard tier; one hypothesis each; tools: get_definition, find_references, read_file, run_check)
  output: finding | "no bug" with evidence

verifier (frontier tier, tool-grounded, one call per candidate)
  must cite the line and the evidence (definition text, tool output) that proves the defect; else drop
  output: keep/drop, confidence 0–1, severity

merge (existing mergeFindings + threshold)
  dedup by fingerprint, rank by severity × confidence, comment budget (default 15, ADR), suppress via feedback
```

Why this should lift recall on our misses: #3 and #6 are "attention" misses inside the diff; per-hunk hypotheses guarantee every hunk gets a focused look. #4, #5, #10 need a definition lookup the hunter can request. Precision is protected by the verifier (tool-grounded, per [S129]) and the existing threshold.

Confidence calibration: log verifier confidence vs judged validity on the benchmark plus a held-out set of clean PRs (bugs: []); fit isotonic regression per category; choose the threshold at the knee where recall on the 50 stops rising. Report both curves.

Cost guard: hypotheses capped by tier (Fast 8, Standard 20, Deep 40), and Auto tier selection like [S211].

## 5. Runtime / execution validation (TREX analogue)

### 5.1 Evidence

- FACT [S206][S207]: TREX runs the PR branch in a sandbox (services, mocks, UI flows, targeted tests) and attaches logs, screenshots, traces. FACT [S205][S206]: "~20% more bugs caught in evals" (Greptile's internal evals, not the [S200] benchmark, which predates TREX).
- FACT [S207]: a standalone test-generation agent did not find bugs; generation must be driven by review hypotheses.
- FACT [S140]: at Meta only 25% of generated tests raised coverage after build/pass filters; FACT [S141][S142][S143]: feedback loops (coverage, error repair) are what make generated tests usable.
- FACT (repo): `services/sandbox-runner` is a skeleton behind the gVisor/Firecracker abstraction (ADR 0005).

### 5.2 Design (PROPOSAL), cheapest first

| Level | What runs | Catches (benchmark examples) | Cost |
|---|---|---|---|
| E0 static tools | language compiler/type checker on changed files: `python -m py_compile` + `mypy --follow-imports=silent` on touched modules; `tsc --noEmit -p`; `go build ./pkg/...` + `go vet`; `javac` via the module's build; `ruby -c` + `rubocop --only Lint` | Undefined names/constants (Grafana "undefined endpoint constants causing compilation errors"), import errors (Sentry #1), wrong arity (Keycloak "ConditionalPasskeysEnabled() called without UserModel") | seconds–minutes; needs deps for typed langs |
| E1 import/instantiate smoke | import every changed module; instantiate changed concrete classes with dummy args when constructor is trivial | Sentry #10 (abstract class → TypeError), #1 | seconds, needs env |
| E2 existing tests | run tests that reference changed symbols (from the graph) | regressions with existing coverage | minutes |
| E3 hypothesis tests | hunter writes a focused test for its hypothesis, runs it, keeps the finding only if the test fails on head and (if applicable) passes on base | numeric/truthiness (#3), null paths (#4), contract changes (#5) | minutes, LLM cost |

Output contract: a finding produced or confirmed by E0–E3 carries `evidence: {command, exitCode, stderrExcerpt}` and gets confidence ≥ 0.9. Execution failures never become comments on their own; the verifier must tie them to a diff line.

Limits: E0/E1 need dependency install per repo (Sentry, Keycloak are heavy: minutes and GBs). Cache per (repo, lockfile hash) images. Runtime-only classes (race conditions in Grafana #1/#10 and Discourse #8/#9, deadlocks) are not reliably caught by E0–E3; they stay with static reasoning.

## 6. Model strategy

### 6.1 Evidence

- FACT [S211]: Greptile's own product exposes depth/cost tiers; FACT [S205]: Greptile routes reviews to a different model family than the author's model.
- FACT [S133]: performance tracked tokens spent and model quality (upgrading the model gave larger gains than doubling tokens on their eval).
- FACT (repo): `defaultPolicy` maps all three tiers (cheap, standard, frontier) to `deepseek/deepseek-v4.1-flash`. There is no real tier separation today.

### 6.2 Is deepseek-v4.1-flash too weak? (MEASURED)

Setup (FACT, logs in job dir `logs/`): the planned ablation ran each of the 10 Sentry cases in two modes: `diff` (unified diff only) and `ctx` (diff + full post-change contents of changed files). Attempt 1 (deepseek-v4.1-flash, claude-sonnet-5-5, gpt-5.6) failed entirely: gateway returned 503/429 "usage limit reached" for DeepSeek, GLM and Claude (`gateway-probe.log`, `ablation-raw.json`). Attempt 2 used the only responsive model, `cx/gpt-5.6-sol`, one call per case per mode (`ablation2-raw.json`). Rule: caught = a finding on the faulty code naming the ground-truth bug (`sentry-ground-truth.json`); a timeout is "no result", never caught.

| # | Ground-truth bug | diff | ctx |
|---|---|---|---|
| 1 | import of non-existent `OptimizedCursorPaginator` | timeout | MISSED (flagged datetime `math.floor` TypeError and negative-offset slice in the new paginator; the class is defined inside the same diff, so the import claim is disputed, see §2) |
| 2 | negative offset bypasses pagination bounds | timeout | timeout |
| 3 | `sample_rate = 0.0` falsy | timeout | timeout |
| 4 | null ref on missing auth user | timeout | timeout |
| 5 | error response format change | timeout | timeout |
| 6 | `shard` vs `shards` tags | timeout | timeout |
| 7 | mutable default timestamp | timeout | timeout |
| 8 | stale config variable | MISSED (flagged removed helper exports instead) | MISSED (same finding) |
| 9 | invalid `queue.ShutDown` handling | timeout | timeout |
| 10 | incomplete `MetricAlertDetectorHandler` | CAUGHT (uninstantiable subclass, abstract methods missing) | timeout |
| | **Total** | **1 caught / 2 results (8 timeouts)** | **0 caught / 2 results (8 timeouts)** |

Finding (FACT): 4 of 20 calls returned; 16 hit the 310–360 s client timeout. With n=2 per arm, the data cannot say whether deepseek-v4.1-flash is too weak or whether added file context helps. The only signal: a frontier-class model caught #10, which our cheap-model run missed; one case is anecdote, not evidence.

Consequence (PROPOSAL): the model-vs-context question stays open and is the first experiment of P0. Rerun with the harness of §1.2, per-call timeout ≥ 600 s or streaming, 3 seeds per case, and include deepseek-v4.1-flash once gateway quota resets, before committing P3 model spend.

### 6.3 Routing design (PROPOSAL)

| Role | Tier | Why |
|---|---|---|
| planner, dedup, summaries | cheap (v4.1-flash) | structured, low reasoning |
| hunters | standard | most tokens; quality matters but volume is high |
| verifier/judge of candidates | frontier | few calls; precision lever |
| benchmark judge | fixed frontier model, pinned version | must not drift between runs |

Escalation: a hunter whose hypothesis is security/contract/concurrency, or a PR in Auto tier "Deep", runs on frontier. Budget per PR enforced by ModelRouter (exists). Cross-family rule like [S205]: if the PR author is a coding agent of family X, hunters use family ≠ X.

## 7. Rules, learning, feedback

### 7.1 Evidence

- FACT [S208][S209][S210]: Greptile learns from team comments, 👍/👎 reactions and replies; learns which comment types a team acts on and filters the rest; improvement over weeks.
- FACT [S213]: `.greptile/` directory-scoped config: `config.json` (strictness 1–3, instructions), `rules.md`, `files.json`, cascading. FACT [S205]: imports `CLAUDE.md`, `AGENTS.md`, `.cursorrules`, `.cursor/rules/**` as context.
- FACT [S215]: CodeRabbit stores natural-language "learnings" from chat per organization and applies them later.
- FACT (repo): `packages/core` already has a `Rule` schema with `kind: natural-language | semgrep | learned`; ARCHITECTURE.md specifies fingerprint suppression from negative Feedback. Brief: feedback capture + suppression exist.
- FACT [S200]: the benchmark ran **default settings, no custom rules**. Learning does not move this benchmark.

### 7.2 Design (PROPOSAL)

- Read repo rule files (`AGENTS.md`, `CLAUDE.md`, `.cursorrules`, `.review/rules.md`) into the context pack (cheap, on by default).
- Learned rules: cluster dismissed/resolved comments per (repo, category, path glob); a cluster with ≥ 5 dismissals and ≥ 80% dismissal rate becomes a `learned` suppression rule; a reply like "we always X" becomes a candidate natural-language rule pending admin approval.
- Positive feedback (resolved + code changed at the line) raises category priors in the calibrator (§4.2).
- Guardrail: learned suppression never applies to severity ≥ high or to the security category.
- Benchmark rule: learning and custom rules are **off** in benchmark runs, to match [S200]. Measure learning separately on internal PR history.

## 8. Language coverage (Python, TypeScript, Go, Java, Ruby)

FACT (repo): there is no language-specific code in the review path. `packages/core` carries a `languages` array on Rule; the api-gateway returns `languages: []`; prompts are generic; ADR 0004 plans tree-sitter for all languages but nothing is implemented.

| Language | Benchmark repo | Today | Missing (PROPOSAL) | Typical benchmark bug classes [S200] |
|---|---|---|---|---|
| Python | Sentry | generic prompt; brief run 3/10 | tree-sitter-python tags + scip-python [S217]; E0 `py_compile`/mypy; version awareness (`.python-version`, `requires-python`) | import/existence, truthiness, abstract classes, contract change |
| TypeScript | Cal.com | generic prompt; never run | tree-sitter-typescript/tsx + scip-typescript; E0 `tsc --noEmit`; Prisma schema in context | async forEach, SQL injection in raw query, timing-safe compare, case-insensitive compare, OR-condition delete |
| Go | Grafana | never run | tree-sitter-go + scip-go [S218]; E0 `go build`/`go vet`/`-race` on touched packages | undefined constants (compile), race conditions, cache expiry, wrong metric methods |
| Java | Keycloak | never run | tree-sitter-java + scip-java; E0 module compile (Maven, heavy; cache) | wrong call arity, recursion via wrong receiver, wrong provider returned, null checks |
| Ruby | Discourse | never run | tree-sitter-ruby + scip-ruby; E0 `ruby -c`; Rails conventions (callbacks, `before_validation`) in rules | SSRF `open(url)`, string mutation with `<<`, thread-safety of lazy ivars, nil refs, DB write in a read predicate |

Per-language prompt addenda (PROPOSAL): short checklists of each language's top bug idioms (above), injected only for files of that language. Cal.com and Discourse also include CSS/SCSS cases (Discourse "float with flexbox", "scale-color for dark themes"); those need the SCSS file in context and no execution.

## 9. Scorecard and phased plan

Impact numbers are PROPOSAL estimates based on §2 and §6. "Sentry Δ" counts which of the 7 misses the capability plausibly converts (the label-disputed #9 is excluded). "50-PR" is the expected overall catch rate after the capability lands on top of all earlier rows (cumulative), starting from an assumed ~30% (we only measured Sentry).

| # | Capability | Sentry misses addressed | Sentry Δ (est.) | 50-PR cumulative (est.) | Effort | Risk |
|---|---|---|---|---|---|---|
| C0 | Benchmark harness + 50-case dataset + judge | none (measurement) | 0 | ~30% (baseline) | M (1–1.5 wk) | Low; label disputes (#9, #1) |
| C1 | Context pack: full files + definitions + base classes + import existence | #1, #4, #10 (+#5 partly) | +2..3 | ~50% | M (2 wk; reuses ADR 0004 plan) | Medium: token budget, resolution quality per language |
| C2 | Planner + per-hunk hypothesis hunters + tool-grounded verifier | #3, #5, #6 | +1..2 | ~62% | M–L (2–3 wk) | Medium: cost 5–15× [S133]; FP rise without verifier |
| C3 | Model tiers: standard/frontier for hunters/verifier | #3, #6, #4 | +1 (overlaps C2) | ~72% | S (config + eval, 3 days) | Low tech, cost risk |
| C4 | Execution E0–E1 (compile/type/import/instantiate) | #1, #10 | +0..1 (overlaps C1) | ~78% | L (3–4 wk; per-language images) | High: env setup for Sentry/Keycloak |
| C5 | Execution E2–E3 (tests, hypothesis tests) | #3, #4, #5 | +0..1 | ~82% | L (4+ wk) | High: flakiness, cost, time |
| C6 | Per-language checklists + version awareness | #9 (would argue valid), #3 | 0..+1 | +2–4 pts | S (1 wk) | Low |
| C7 | Learning / rules | none (benchmark is default settings) | 0 | 0 | M | Low for benchmark; product value only |
| C8 | Calibration + comment budget tuning | protects precision | 0 | 0 (keeps FP ≤ target) | S | Low |

Phased plan (PROPOSAL). Each phase ends on a benchmark run (3 runs, mean).

| Phase | Build | Exit criteria (measured by C0 harness) |
|---|---|---|
| P0 | C0 | All 50 cases extracted with base/head SHAs; judge agreement with a human on 20 hand-labelled comments ≥ 90%; baseline (current engine) reported on 50, 3 runs; cost/latency recorded. |
| P1 | C1 + C6 prompts | Context-pack coverage ≥ 90% (§3.2 gate); Sentry ≥ 6/10; 50-PR ≥ 50%. |
| P2 | C2 + C8 | Sentry ≥ 7/10; 50-PR ≥ 62%; ≤ 8 comments/PR median; judged-valid rate of non-target comments ≥ 50% (sample). |
| P3 | C3 | Sentry ≥ 8/10; 50-PR ≥ 72% (≥ 36/50); median model spend ≤ $0.50/PR. |
| P4 | C4 (Python, TS, Go first; Java/Ruby after) | 50-PR ≥ 78%; no execution-only comment without a diff anchor. |
| P5 | C5, then C7 for product | 50-PR ≥ 82% (≥ 41/50, Greptile parity) on 3-run mean; held-out set (new PRs from the same 5 repos, not in [S200]) within 10 pts of the 50-PR score to rule out overfitting. |

Overfitting warning (PROPOSAL): 50 public cases are small and visible. Keep a held-out set of fresh bug-fix PRs from the same repos (built the same way) and report both; never tune prompts on case text.

## 10. Open questions and limits

- The brief's 3/10 run is not reproducible from this repo: `runReview`, `agent-runner` logic, `OpenAICompatibleProvider` and `mergeFindings` are not in branch `boat/9cb2077fec85` (services are skeletons there). Root causes in §2 rest on PR evidence [S201] plus the ablation in §6.2, not on our engine's actual outputs.
- Benchmark labels: #9 is valid code on Python 3.13 [S216]; #1's "missing class" is defined in the fork head. Report scores with and without disputed cases.
- [S200] is July 2025; all five tools have shipped new versions since (e.g. Greptile v5 [S204], TREX [S205]). Parity with the published 82% is a fixed target, not today's Greptile.
