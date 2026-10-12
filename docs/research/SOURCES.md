# Sources

Accessed 2026-10-11. IDs S1-S99 cover competitors (01-competitors.md). IDs S100-S199 cover technical and literature sources (00, 02-07). Docs cite these as [S#]. A claim without a source is labelled PROPOSAL.

## Competitors (S1-S99)


All sources fetched directly on 2026-10-11. IDs S1..S99 only. Used by `01-competitors.md`.

## Greptile
- [S1] Greptile Docs — Key Features — https://www.greptile.com/docs/code-review/key-features — accessed 2026-10-11 — repo graph, T-Rex sandboxed test execution, review tiers, greptile.json rules, thumbs learning, auto-approve, Fix-with-agent.
- [S2] Greptile blog — Greptile v3, an agentic approach to code review — https://www.greptile.com/blog/greptile-v3-agentic-code-review — accessed 2026-10-11 — v2 flowchart vs v3 tool-loop agent, acceptance +70.5%, caching cuts self-hosted inference cost 75%.
- [S3] Greptile Pricing — https://www.greptile.com/pricing — accessed 2026-10-11 — Free/Pro $30 seat/mo + credits ($1/credit; Base 1, Plus 3, Apex 10)/Enterprise self-host.
- [S4] Greptile — The code reviewer that catches real bugs (agent page) — https://www.greptile.com/agent — accessed 2026-10-11 — index graph, "swarm" of parallel agents, 0-5 confidence score, ./greptile/rules scoped rules.
- [S5] Greptile Docs — Graph-based Codebase Context — https://www.greptile.com/docs/how-greptile-works/graph-based-codebase-context — accessed 2026-10-11 — parse files, extract entities, map call/import relationships, store graph, query at review time.
- [S6] Greptile Docs — Memory and Learning — https://www.greptile.com/docs/how-greptile-works/memory-and-learning — accessed 2026-10-11 — learns from team comments, replies, reactions, and whether comments were addressed between first/last commit.

## CodeRabbit
- [S7] CodeRabbit Docs — Learnings — https://docs.coderabbit.ai/knowledge-base/learnings — accessed 2026-10-11 — natural-language learnings created from chat, scoped repo/org, path-pattern eligible, editable.
- [S8] CodeRabbit Docs — Knowledge base — https://docs.coderabbit.ai/knowledge-base — accessed 2026-10-11 — context sources: learnings, auto-read CLAUDE.md/.cursorrules, multi-repo, MCP, web search, issues, past PRs; opt_out.
- [S9] CodeRabbit Docs — Self-hosted overview — https://docs.coderabbit.ai/self-hosted/overview — accessed 2026-10-11 — Enterprise self-host for 500+ seats, BYO model, GitHub/GitLab/Azure DevOps/Bitbucket DC.
- [S10] CodeRabbit Pricing — https://www.coderabbit.ai/pricing — accessed 2026-10-11 — tiers, Blast Radius, security review, self-hosting on Enterprise.
- [S11] CodeRabbit Docs — Plans — https://docs.coderabbit.ai/management/plans — accessed 2026-10-11 — Essentials $24/$30, Team $48/$60, Advanced $72 per dev/mo; per-developer rate limits; usage-based add-on.
- [S12] CodeRabbit Docs — Third-party tools overview — https://docs.coderabbit.ai/tools/ — accessed 2026-10-11 — 50+ linters/SAST run in sandbox, auto-selected per language, .coderabbit.yaml.
- [S13] CodeRabbit blog — How we built our AI code review tool for IDEs — https://www.coderabbit.ai/blog/how-we-built-our-ai-code-review-tool-for-ides — accessed 2026-10-11 — non-linear PR pipeline, multi-step verification, batch delivery to minimise noise.

## Graphite
- [S14] Graphite Pricing — https://graphite.dev/pricing — accessed 2026-10-11 — Hobby free, Starter $20, Team $40 (unlimited AI reviews), Enterprise; banner "Cursor Cloud Agents are now in Graphite".
- [S15] Graphite Docs — AI reviews (Graphite Agent) — https://graphite.dev/docs/ai-reviews — accessed 2026-10-11 — focuses on real bugs, whole-codebase context, learns from feedback.
- [S16] Graphite Docs — AI Privacy and Security — https://graphite.dev/docs/ai-privacy-and-security — accessed 2026-10-11 — Anthropic/OpenAI subprocessors; sends diff, related PRs, related code; no training.

## CodeScene
- [S17] CodeScene Pricing — https://codescene.com/pricing — accessed 2026-10-11 — CodeHealth MCP server, automated PR review with quality gates, hotspots, code quality profiles, active-author based tiers.
- [S18] CodeScene — ACE AI refactoring — https://codescene.com/product/ai-coding — accessed 2026-10-11 — ACE refactors code smells guided by Code Health metric; mixed OpenAI/Anthropic/Google LLMs; no training on code.
- [S19] CodeScene Docs — Getting started — https://codescene.io/docs/getting-started/index.html — accessed 2026-10-11 — behavioural analysis of VCS history; on-premises version exists.

## Semgrep
- [S20] Semgrep Docs — Semgrep Multimodal (formerly Assistant) overview — https://semgrep.dev/docs/semgrep-assistant/overview — accessed 2026-10-11 — AI detection (IDOR/authz), explanations, autotriage from triage history, noise filtering suppresses PR comments.
- [S21] Semgrep Docs — Customize Multimodal / Memories — https://semgrep.dev/docs/semgrep-assistant/customize — accessed 2026-10-11 — Memories scoped per project/rule/vuln class; memory suggestions from triage feedback; noise filter modes.
- [S22] Semgrep Pricing — https://semgrep.dev/pricing — accessed 2026-10-11 — Code $30/contributor/mo, Secrets $15; AI credits 20/50 per dev; contributor = commit in 90 days; on-prem SCM support.
- [S23] Semgrep Docs — Multimodal metrics and methodology — https://semgrep.dev/docs/semgrep-assistant/metrics — accessed 2026-10-11 — 96% human-agree, 60% finding reduction, thumbs feedback + internal benchmark.

## Snyk
- [S24] Snyk Docs — Snyk Code — https://docs.snyk.io/scan-with-snyk/snyk-code — accessed 2026-10-11 — developer-first SAST across IDE/repo/CI, AI-based engine, priority score.
- [S25] Snyk Docs — Fix code vulnerabilities automatically (Snyk Agent Fix) — https://docs.snyk.io/scan-with-snyk/snyk-code/manage-code-vulnerabilities/fix-code-vulnerabilities-automatically — accessed 2026-10-11 — DeepCode AI Fix renamed; dynamic few-shot from 35k fix pairs; k candidates; SAST re-verify; agentic retry.
- [S26] Snyk blog — New Agentic Architecture for Snyk Agent Fix (2026-04-27) — https://snyk.io/blog/snyk-agent-fix-agentic-architecture/ — accessed 2026-10-11 — moved from fine-tuning to dynamic few-shot; Pass@1/Pass@5 benchmarking.
- [S27] Snyk — DeepCode AI — https://snyk.io/platform/deepcode-ai/ — accessed 2026-10-11 — hybrid symbolic + generative AI, 25M+ dataflow cases, trained on permissive OSS fixes not customer data.
- [S28] Snyk Plans — https://snyk.io/plans/ — accessed 2026-10-11 — credit-based enterprise: Code 1.0 credit per active contributor per day.
- [S29] Snyk Docs — Snyk Broker — https://docs.snyk.io/snyk-platform-administration/snyk-broker — accessed 2026-10-11 — open-source proxy connecting Snyk SaaS to on-prem SCM (Enterprise).

## Qodo / PR-Agent
- [S30] GitHub — the-pr-agent/pr-agent (formerly qodo-ai/pr-agent) — https://github.com/qodo-ai/pr-agent — accessed 2026-10-11 — community-maintained legacy OSS; one LLM call per tool; CLI/Action/Docker; GitHub/GitLab/Bitbucket/Azure.
- [S31] PR-Agent LICENSE — https://raw.githubusercontent.com/the-pr-agent/pr-agent/main/LICENSE — accessed 2026-10-11 — MIT licence.
- [S32] PR-Agent Docs — PR Compression strategy — https://docs.pr-agent.ai/core-abilities/compression_strategy/ — accessed 2026-10-11 — language prioritisation, drop deletion-only hunks, tiktoken-aware patch fitting.
- [S33] Qodo Docs — home — https://qodo-merge-docs.qodo.ai/ — accessed 2026-10-11 — parallel specialist agents + judge agent dedupe/filter; Review Standards; Rule Miner; cross-repo; .pr_agent.toml.
- [S34] Qodo Docs — How Qodo code review works — https://docs.qodo.ai/code-review/overview — accessed 2026-10-11 — finding types (bugs, rule violations, requirement gaps, Figma UX, cross-repo); four context sources.
- [S35] Qodo Docs — Understanding PR history indexing — https://docs.qodo.ai/core-concepts/pr-history — accessed 2026-10-11 — Context Engine indexes past PRs; fixed vs dismissed outcome decides relevance.
- [S36] Qodo Pricing — https://www.qodo.ai/pricing/ — accessed 2026-10-11 — Pro Team $30 + credit packs ($.012/credit); Enterprise: BYOK, single-tenant/on-prem/air-gapped, self-learning.

## Sourcegraph / Amp
- [S37] Sourcegraph Docs — Cody — https://sourcegraph.com/docs/cody — accessed 2026-10-11 — Cody on Sourcegraph Enterprise; context via Sourcegraph Search API across local/remote repos.
- [S38] Sourcegraph Docs — Deployment overview — https://sourcegraph.com/docs/admin/deploy — accessed 2026-10-11 — Enterprise: Sourcegraph Cloud or self-hosted deployments.
- [S39] Amp Manual — https://ampcode.com/manual — accessed 2026-10-11 — multi-model coding agent; per-thread cloud machines ("orbs"); CLI/web/apps.
- [S40] Amp News — Review — https://ampcode.com/news/review — accessed 2026-10-11 — review panel: AI summary, guided tour with reading order, full diffs with navigation.
- [S41] Amp News — Amp Free — https://ampcode.com/news/amp-free — accessed 2026-10-11 — ad-supported free mode, now paused.

## Cursor Bugbot
- [S42] Cursor Docs — Bugbot — https://cursor.com/docs/bugbot — accessed 2026-10-11 — rule merge order, BUGBOT.md traversal, learned rules, `@cursor remember`, verbose rule table, Autofix via Cloud Agent, GitHub/GitLab/Bitbucket/Azure.
- [S43] Cursor blog — Building Bugbot — https://cursor.com/blog/building-bugbot — accessed 2026-10-11 — 8 parallel passes + majority vote + validator; resolution-rate metric; BugBench; move to agentic design; 2M PRs/mo.
- [S44] Cursor Pricing — https://cursor.com/pricing — accessed 2026-10-11 — Bugbot on usage-based billing for Individual; included on Teams $40/user/mo.
- [S45] Cursor Docs — Models & Pricing — https://cursor.com/docs/account/pricing — accessed 2026-10-11 — two usage pools; third-party models charged at API price.

## Sweep
- [S46] GitHub — sweepai/sweep — https://github.com/sweepai/sweep — accessed 2026-10-11 — repo now states Sweep pivoted to a JetBrains AI coding assistant.

## Ellipsis
- [S47] Ellipsis — home — https://www.ellipsis.dev — accessed 2026-10-11 — repositioned as "Agents as a Service" platform (incl. code review); scoped credentials; zero source retention.
- [S48] Ellipsis Pricing — https://www.ellipsis.dev/pricing — accessed 2026-10-11 — $0 seats, tokens at cost + 10% platform fee; managed SaaS or customer AWS VPC.
- [S49] Ellipsis Docs — Code review — https://docs.ellipsis.dev/code-review — accessed 2026-10-11 — `.ellipsis/code-review.yaml` with multiple reviewers (prompt/model/paths/budget), blocking flags, incremental per-push review.


## Technical and literature (S100-S199)


Every URL below was fetched on 2026-10-11 (HTTP 200, title checked). Arxiv titles and abstracts were checked through the arxiv export API. Docs 02–07 and 00 cite these IDs. Competitor sources belong to `01-competitors.md` and use a separate ID range.

## Indexing and retrieval (doc 02)

- [S100] Stack graphs: Name resolution at scale (Creager & van Antwerpen, arXiv:2211.01224) — https://arxiv.org/abs/2211.01224 — accessed 2026-10-11 — stack graphs power GitHub Precise Code Navigation; they are built file-incrementally from syntax only, with no build or per-package configuration.
- [S101] Introducing stack graphs (GitHub Blog) — https://github.blog/open-source/introducing-stack-graphs/ — accessed 2026-10-11 — most commits change only a few files, so incremental processing and storage reuse are required at scale.
- [S102] github/stack-graphs repository — https://github.com/github/stack-graphs — accessed 2026-10-11 — Rust implementation of stack graphs.
- [S103] Tree-sitter introduction — https://tree-sitter.github.io/tree-sitter/ — accessed 2026-10-11 — incremental parsing library; builds concrete syntax trees, updates them efficiently on edit, stays robust under syntax errors, and ships as a dependency-free C11 runtime.
- [S104] web-tree-sitter (tree-sitter lib/binding_web) — https://github.com/tree-sitter/tree-sitter/tree/master/lib/binding_web — accessed 2026-10-11 — official WebAssembly bindings for tree-sitter.
- [S105] SCIP Code Intelligence Protocol repository — https://github.com/sourcegraph/scip — accessed 2026-10-11 — Protobuf schema used for go-to-definition, find-references and find-implementations, with Go/Rust/TypeScript bindings and a CLI.
- [S106] scip-typescript — https://github.com/sourcegraph/scip-typescript — accessed 2026-10-11 — SCIP indexer for TypeScript and JavaScript.
- [S107] LSIF specification 0.6.0 — https://microsoft.github.io/language-server-protocol/specifications/lsif/0.6.0/specification/ — accessed 2026-10-11 — the older Language Server Index Format.
- [S108] Aider: Repository map — https://aider.chat/docs/repomap.html — accessed 2026-10-11 — repo map of key symbols and signatures, ranked by a graph algorithm over the file-dependency graph to fit a token budget.
- [S109] RepoCoder (arXiv:2303.12570) — https://arxiv.org/abs/2303.12570 — accessed 2026-10-11 — iterative retrieval-generation improves repository-level completion.
- [S110] RepoGraph (arXiv:2410.14684) — https://arxiv.org/abs/2410.14684 — accessed 2026-10-11 — a repository-level code graph plugged into SWE-bench methods boosts all of them.
- [S111] cAST: Structural Chunking via AST (arXiv:2506.15655) — https://arxiv.org/abs/2506.15655 — accessed 2026-10-11 — AST-based chunking beats line-based chunking (+4.3 Recall@5 on RepoEval, +2.67 Pass@1 on SWE-bench).
- [S112] CodeRAG-Bench (arXiv:2406.14497) — https://arxiv.org/abs/2406.14497 — accessed 2026-10-11 — retrievers struggle when lexical overlap is limited, and generators fail to use extra context well.
- [S113] Lost in the Middle (arXiv:2307.03172) — https://arxiv.org/abs/2307.03172 — accessed 2026-10-11 — LLMs use information in the middle of long contexts less reliably.
- [S114] HNSW (Malkov & Yashunin, arXiv:1603.09320) — https://arxiv.org/abs/1603.09320 — accessed 2026-10-11 — the HNSW approximate nearest-neighbour algorithm.
- [S115] pgvector README — https://github.com/pgvector/pgvector — accessed 2026-10-11 — HNSW/IVFFlat indexes; vector ≤2,000 dims, halfvec ≤4,000 dims; default m=16 and ef_search=40; filtering reduces results, mitigated by iterative scans and partial indexes.
- [S116] voyage-code-3 announcement (Voyage AI) — https://blog.voyageai.com/2024/12/04/voyage-code-3/ — accessed 2026-10-11 — code embedding model with a 32K context, Matryoshka dimensions and int8/binary quantization; vendor-reported +13.80% over OpenAI-v3-large across 32 datasets.

## Review engine (doc 03)

- [S120] Semgrep documentation — https://semgrep.dev/docs/ — accessed 2026-10-11 — Semgrep rules, CLI and CI usage.
- [S121] semgrep/semgrep repository — https://github.com/semgrep/semgrep — accessed 2026-10-11 — Semgrep CE is LGPL-2.1 and supports many languages with source-like patterns.
- [S122] Semgrep Multimodal (Assistant) overview — https://semgrep.dev/docs/semgrep-assistant/overview — accessed 2026-10-11 — commercial LLM triage; "noise filtering" suppresses PR comments for likely false positives so security teams can review them separately.
- [S123] CodeQL documentation — https://codeql.github.com/docs/ — accessed 2026-10-11 — CodeQL queries code as data for variant analysis.
- [S124] IRIS: LLM-Assisted Static Analysis (arXiv:2405.17238) — https://arxiv.org/abs/2405.17238 — accessed 2026-10-11 — on CWE-Bench-Java (120 vulnerabilities), CodeQL finds 27 and IRIS with GPT-4 finds 55; IRIS lowers the false discovery rate by about 5 points.
- [S125] Vulnerability Detection with Code LMs: How Far Are We? / PrimeVul (arXiv:2403.18624) — https://arxiv.org/abs/2403.18624 — accessed 2026-10-11 — a 7B model scores 68.26% F1 on BigVul but 3.09% on PrimeVul; earlier benchmarks overestimate LLM vulnerability detection.
- [S126] Self-Refine (arXiv:2303.17651) — https://arxiv.org/abs/2303.17651 — accessed 2026-10-11 — iterative self-feedback refinement.
- [S127] Reflexion (arXiv:2303.11366) — https://arxiv.org/abs/2303.11366 — accessed 2026-10-11 — verbal reinforcement from environment feedback.
- [S128] Large Language Models Cannot Self-Correct Reasoning Yet (arXiv:2310.01798) — https://arxiv.org/abs/2310.01798 — accessed 2026-10-11 — intrinsic self-correction without external feedback can make results worse.
- [S129] CRITIC (arXiv:2305.11738) — https://arxiv.org/abs/2305.11738 — accessed 2026-10-11 — tool-interactive critique works; external feedback is the important part.
- [S130] Resolving code review comments with ML (Google Research blog) — https://research.google/blog/resolving-code-review-comments-with-ml/ — accessed 2026-10-11 — model calibrated to a 50% target precision; addresses 52% of comments offline; raising precision shows fewer suggestions.
- [S131] AutoCommenter (arXiv:2405.13565) — https://arxiv.org/abs/2405.13565 — accessed 2026-10-11 — Google's industrial LLM best-practice commenter, deployed to tens of thousands of developers, with lessons from deployment.
- [S132] Building Effective AI Agents (Anthropic) — https://www.anthropic.com/research/building-effective-agents — accessed 2026-10-11 — start with the simplest solution; describes workflow patterns including evaluator-optimizer.
- [S133] How we built our multi-agent research system (Anthropic) — https://www.anthropic.com/engineering/multi-agent-research-system — accessed 2026-10-11 — multi-agent uses ~15× the tokens of chat; scored +90.2% on an internal eval; a poor fit for tightly coupled tasks.
- [S134] Agentless (arXiv:2407.01489) — https://arxiv.org/abs/2407.01489 — accessed 2026-10-11 — a simple fixed pipeline scored 32.00% on SWE-bench Lite at $0.70 per issue, beating open-source agents.
- [S135] SWE-agent (arXiv:2405.15793) — https://arxiv.org/abs/2405.15793 — accessed 2026-10-11 — agent-computer interface design drives agent performance.
- [S136] gitleaks repository — https://github.com/gitleaks/gitleaks — accessed 2026-10-11 — open-source secret scanner.
- [S137] google/osv-scanner repository — https://github.com/google/osv-scanner — accessed 2026-10-11 — dependency vulnerability scanner backed by osv.dev.

## Test generation (doc 04)

- [S140] Automated Unit Test Improvement using LLMs at Meta / TestGen-LLM (arXiv:2402.09171) — https://arxiv.org/abs/2402.09171 — accessed 2026-10-11 — filters require build, reliable pass and coverage gain: 75% built, 57% passed reliably, 25% raised coverage; 73% of recommendations accepted.
- [S141] CoverUp (arXiv:2403.16218) — https://arxiv.org/abs/2403.16218 — accessed 2026-10-11 — coverage-feedback loop reaches 80% median per-module line+branch coverage vs CodaMosa 47%, and 89% vs MuTAP 77%.
- [S142] ChatUniTest (arXiv:2305.04764) — https://arxiv.org/abs/2305.04764 — accessed 2026-10-11 — adaptive focal context plus a generation-validation-repair loop.
- [S143] An Empirical Evaluation of LLMs for Automated Unit Test Generation / TestPilot (arXiv:2302.06527) — https://arxiv.org/abs/2302.06527 — accessed 2026-10-11 — JS/npm test generation that repairs failing tests by re-prompting with the error; results depend on the model.
- [S144] Mutation-Guided LLM-based Test Generation at Meta / ACH (arXiv:2501.12862) — https://arxiv.org/abs/2501.12862 — accessed 2026-10-11 — targeted mutants, then tests that kill them; 9,095 mutants and 571 tests; 73% of tests accepted; LLM equivalent-mutant detector.
- [S145] SWT-Bench (arXiv:2406.12952) — https://arxiv.org/abs/2406.12952 — accessed 2026-10-11 — benchmark for issue-reproducing tests; generated tests double SWE-Agent precision when used as a filter.
- [S146] SWE-bench (arXiv:2310.06770) — https://arxiv.org/abs/2310.06770 — accessed 2026-10-11 — 2,294 real GitHub issue/PR tasks across 12 Python repos, evaluated by executing tests.
- [S147] Stryker Mutator — https://stryker-mutator.io/ — accessed 2026-10-11 — mutation testing for JS/TS, C# and Scala.
- [S148] SWE-bench leaderboards site — https://www.swebench.com/ — accessed 2026-10-11 — Verified (500 instances), Lite, Multilingual and Multimodal leaderboards.

## Scoring (doc 05)

- [S150] CodeReviewer: Automating Code Review Activities by Large-Scale Pre-training (Li et al., arXiv:2203.09095) — https://arxiv.org/abs/2203.09095 — accessed 2026-10-11 — nine-language dataset; three tasks: quality estimation, comment generation, code refinement.
- [S151] Automated Code Review In Practice (arXiv:2412.18531) — https://arxiv.org/abs/2412.18531 — accessed 2026-10-11 — industrial Qodo PR-Agent study: 73.8% of automated comments resolved; mean PR closure grew from 5h52m to 8h20m.
- [S152] CRScore (arXiv:2409.19801) — https://arxiv.org/abs/2409.19801 — accessed 2026-10-11 — reference-free review-quality metric with 0.54 Spearman against human judgment; 2.9k human-annotated scores.
- [S153] SWR-Bench (arXiv:2509.01494) — https://arxiv.org/abs/2509.01494 — accessed 2026-10-11 — 1,000 verified PRs with full project context; LLM judge with ~90% human agreement; multi-review aggregation raises F1 by up to 43.67%.
- [S154] ContextCRBench (arXiv:2511.07017) — https://arxiv.org/abs/2511.07017 — accessed 2026-10-11 — 67,910 entries; hunk/line-level tasks; textual context helps more than code context.
- [S155] Greptile AI Code Review Benchmarks 2025 — https://www.greptile.com/benchmarks — accessed 2026-10-11 — vendor benchmark: 5 tools, 50 real bugs, 5 repos; measures catch rate, noise and time. Vendor-run, so treat as biased.

## Self-host and security (doc 06)

- [S160] AICPA SOC suite of services — https://www.aicpa-cima.com/topic/audit-assurance/audit-and-assurance-greater-than-soc-2 — accessed 2026-10-11 — SOC 2 reports on controls relevant to Security, Availability, Processing Integrity, Confidentiality or Privacy.
- [S161] AICPA 2017 Trust Services Criteria (revised points of focus 2022) — https://www.aicpa-cima.com/resources/download/2017-trust-services-criteria-with-revised-points-of-focus-2022 — accessed 2026-10-11 — the criteria document SOC 2 is examined against.
- [S162] Amazon Bedrock data protection — https://docs.aws.amazon.com/bedrock/latest/userguide/data-protection.html — accessed 2026-10-11 — model providers have no access to Bedrock logs, prompts or completions.
- [S163] Azure Foundry / Azure OpenAI data, privacy and security — https://learn.microsoft.com/en-us/legal/cognitive-services/openai/data-privacy — accessed 2026-10-11 — prompts and completions are not available to OpenAI and not used for training; abuse monitoring can be modified on application.
- [S164] Vertex AI zero data retention — https://cloud.google.com/vertex-ai/generative-ai/docs/vertex-ai-zero-data-retention — accessed 2026-10-11 — default 24h in-memory cache and abuse-monitoring prompt logging; customers must act to reach ZDR.
- [S165] vllm-project/vllm repository — https://github.com/vllm-project/vllm — accessed 2026-10-11 — OpenAI-compatible API server.
- [S166] Ollama OpenAI compatibility — https://docs.ollama.com/api/openai-compatibility — accessed 2026-10-11 — Ollama supports a subset of the OpenAI API.
- [S167] OpenRouter provider routing — https://openrouter.ai/docs/features/provider-routing — accessed 2026-10-11 — provider selection, model fallbacks, data-collection policy controls.
- [S168] OpenRouter Zero Data Retention — https://openrouter.ai/docs/features/zdr — accessed 2026-10-11 — ZDR routing control.
- [S169] PostgreSQL 16 Row Security Policies — https://www.postgresql.org/docs/16/ddl-rowsecurity.html — accessed 2026-10-11 — superusers and BYPASSRLS roles always bypass RLS; table owners bypass unless FORCE ROW LEVEL SECURITY is set.
- [S170] Multi-tenant data isolation with PostgreSQL RLS (AWS Database Blog) — https://aws.amazon.com/blogs/database/multi-tenant-data-isolation-with-postgresql-row-level-security/ — accessed 2026-10-11 — pool model with policies on `current_setting('app.current_tenant')`.
- [S171] AWS KMS cryptography essentials — https://docs.aws.amazon.com/kms/latest/developerguide/kms-cryptography.html — accessed 2026-10-11 — envelope encryption with data keys.
- [S172] Generating an installation access token for a GitHub App — https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app — accessed 2026-10-11 — installation tokens expire after 1 hour and can be scoped to repositories and permissions.
- [S173] gVisor: What is gVisor? — https://gvisor.dev/docs/ — accessed 2026-10-11 — userspace application kernel written in Go; `runsc` OCI runtime for Docker and Kubernetes.
- [S174] gVisor security model — https://gvisor.dev/docs/architecture_guide/security/ — accessed 2026-10-11 — threat model centred on the system-call API.
- [S175] Firecracker — https://firecracker-microvm.github.io/ — accessed 2026-10-11 — KVM microVMs with 5 emulated devices, <125 ms boot, <5 MiB overhead, up to 150 VMs/s per host.
- [S176] Firecracker: Lightweight Virtualization for Serverless Applications (NSDI '20) — https://www.usenix.org/conference/nsdi20/presentation/agache — accessed 2026-10-11 — runs AWS Lambda and Fargate in production.
- [S177] Kata Containers — https://katacontainers.io/ — accessed 2026-10-11 — container runtime backed by lightweight VMs.
- [S178] Amazon Bedrock inference profiles — https://docs.aws.amazon.com/bedrock/latest/userguide/inference-profiles.html — accessed 2026-10-11 — inference profiles, including cross-region, are relevant to data residency.

## Frameworks (doc 07)

- [S180] Node.js releases — https://nodejs.org/en/about/previous-releases — accessed 2026-10-11 — v24 is the Latest LTS; even-numbered releases become Active LTS.
- [S181] pnpm workspaces — https://pnpm.io/workspaces — accessed 2026-10-11 — `pnpm-workspace.yaml` and the `workspace:` protocol.
- [S182] Fastify — https://fastify.dev/ — accessed 2026-10-11 — low overhead; schema-compiled validation and serialization; plugin encapsulation; Pino logging; v5 on Node 20+.
- [S183] fastify-type-provider-zod — https://github.com/turkerdev/fastify-type-provider-zod — accessed 2026-10-11 — Zod type provider for Fastify.
- [S184] Zod — https://zod.dev/ — accessed 2026-10-11 — TypeScript-first schema validation.
- [S185] BullMQ docs — https://docs.bullmq.io/ — accessed 2026-10-11 — queues, priorities, deduplication, retries, stalled-job handling, sandboxed processors, global concurrency and rate limits, telemetry.
- [S186] BullMQ flows — https://docs.bullmq.io/guide/flows — accessed 2026-10-11 — parent/child job dependency trees.
- [S187] Valkey — https://valkey.io/ — accessed 2026-10-11 — BSD-licensed key/value store under the Linux Foundation.
- [S188] Temporal Workflows — https://docs.temporal.io/workflows — accessed 2026-10-11 — durable workflow execution model.
- [S189] Vitest — https://vitest.dev/ — accessed 2026-10-11 — Vite-native test framework.
- [S190] OpenTelemetry JavaScript — https://opentelemetry.io/docs/languages/js/ — accessed 2026-10-11 — traces, metrics and logs for Node.js.
- [S191] BullMQ rate limiting — https://docs.bullmq.io/guide/rate-limiting — accessed 2026-10-11 — per-queue rate limiting.

Count: 81 sources (S100–S116, S120–S137, S140–S148, S150–S155, S160–S178, S180–S191).

## Greptile gap analysis (S200–S218)

Added for [GREPTILE-GAP.md](./GREPTILE-GAP.md). Raw fetched copies are kept in the job log directory, not in the repo.

- [S200] Greptile — AI Code Review Benchmarks — https://www.greptile.com/benchmarks — accessed 2026-10-12 — 5 tools, 50 bug-fix PRs, 5 repos (Sentry, Cal.com, Grafana, Keycloak, Discourse); overall catch Greptile 82%, Bugbot 58%, Copilot 54%, CodeRabbit 44%, Graphite 6%; per-severity table; methodology: before/after branches, PR replicated on 5 clean forks, default settings, "caught" = explicit line-level comment naming the faulty code and explaining impact; run July 2025; per-PR case library with links.
- [S201] ai-code-review-evaluation/sentry-greptile pull requests 1–10 (GitHub API: pulls, files, review comments) — https://github.com/ai-code-review-evaluation/sentry-greptile/pulls — accessed 2026-10-12 — the public benchmark forks; PR heads, base branches, diffs and the reviewer's line comments used for root-cause analysis in GREPTILE-GAP.md §2.
- [S202] Greptile Docs — Graph-based Codebase Context — https://www.greptile.com/docs/how-greptile-works/graph-based-codebase-context — accessed 2026-10-12 — Greptile builds a complete graph of the codebase (functions, relationships, dependencies) to see how a change affects other parts of the system.
- [S203] Greptile Blog — Greptile v4 + New Pricing — https://www.greptile.com/blog/greptile-v4 — accessed 2026-10-12 — v4 A/B tested over hundreds of thousands of PRs: addressed comments per PR 0.92→1.60; share of comments addressed 30%→43%.
- [S204] Greptile Blog — Greptile Agent v5 — https://www.greptile.com/blog/greptile-v5 — accessed 2026-10-12 — v5 "spins up a swarm of agents that each explore one hypothesis for a potential bug", in parallel; narrow scope lets each agent explore deeper; comments addressed 52%→66%.
- [S205] Greptile Changelog — https://www.greptile.com/changelog — accessed 2026-10-12 — v5 swarm of narrowly scoped agents; TREX public beta "writes and runs targeted tests in a sandbox, resulting in 20% more bugs caught in evals"; security agent pairs static scanning + dependency checks + AI; cross-model review when a coding agent authored the PR; imports CLAUDE.md/AGENTS.md/.cursorrules as custom context.
- [S206] Greptile — TREX product page — https://www.greptile.com/trex — accessed 2026-10-12 — runs the PR branch in a sandbox; starts services, mocks inputs, clicks UI flows; leaves logs/screenshots/traces; "~20% more bugs than review alone".
- [S207] Greptile Blog — Building TREX: Code Execution and Artifact Generation for AI Code Review — https://www.greptile.com/blog/trex-code-execution — accessed 2026-10-12 — static review "has a ceiling"; a standalone test-generation agent did not surface bugs; a single combined agent was overloaded; final design: orchestrator spawns parallel sandboxed subagents; findings backed by screenshots, logs, API traces, scripts.
- [S208] Greptile Docs — Memory and Learning — https://www.greptile.com/docs/how-greptile-works/memory-and-learning — accessed 2026-10-12 — learns from team PR comments, reactions and replies; pattern analysis updates rules.
- [S209] Greptile Docs — Training the Learning System — https://www.greptile.com/docs/code-review/training-the-learning-system — accessed 2026-10-12 — 👍/👎 reactions and explanatory replies train relevance; improvement over weeks.
- [S210] Greptile Docs — Reducing Nitpicks — https://www.greptile.com/docs/how-greptile-works/nitpicks — accessed 2026-10-12 — learns which comment types the team acts on and filters the rest.
- [S211] Greptile Docs — Review Tiers — https://www.greptile.com/docs/code-review/review-tiers — accessed 2026-10-12 — tiers cost 1/3/10 credits; higher tiers "take longer, catch more, and cost more"; Auto picks tier per PR from size, risk, complexity; Apex for large PRs.
- [S212] Greptile Docs — Knowledge Base — https://www.greptile.com/docs/how-greptile-works/knowledge-bases — accessed 2026-10-12 — per-repo living docs (index, glossary, per-area/flow docs with risk areas) read on every review.
- [S213] Greptile Docs — .greptile/ File Reference — https://www.greptile.com/docs/code-review/greptile-config-reference — accessed 2026-10-12 — config.json (strictness 1–3, instructions), rules.md, files.json; directory-scoped cascading.
- [S214] CodeRabbit Docs — Knowledge Base overview — https://docs.coderabbit.ai/integrations/knowledge-base — accessed 2026-10-12 — context beyond the diff: learnings, code guidelines, multi-repo analysis, MCP servers, web search, linked issues.
- [S215] CodeRabbit Docs — Learnings — https://docs.coderabbit.ai/guides/learnings — accessed 2026-10-12 — natural-language review preferences captured from chat, stored per organization, applied to later reviews.
- [S216] Python docs — queue module — https://docs.python.org/3/library/queue.html — accessed 2026-10-12 — `queue.ShutDown` and `Queue.shutdown(immediate=False)` "Added in version 3.13".
- [S217] SCIP Code Intelligence Protocol — https://github.com/sourcegraph/scip — accessed 2026-10-12 — indexers: scip-java, scip-typescript, scip-python, scip-ruby, scip-clang, scip-dotnet.
- [S218] scip-go — https://github.com/scip-code/scip-go — accessed 2026-10-12 — SCIP indexer for Go.
