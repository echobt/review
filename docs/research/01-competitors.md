# AI code-review competitors

Checked: 2026-10-11. Sources: [`SOURCES.md`](./SOURCES.md).

Convention per subsection:
- **FACT** — stated by a cited primary source [S#], fetched 2026-10-11.
- **PROPOSAL / inference** — our reading or recommendation. Not vendor-confirmed.

Pricing changes often; every price below is "as published on 2026-10-11".

---

## 1. Greptile

**How review works**
- FACT: Reviews PRs with full codebase context; defaults to logic, security, performance and architecture issues, with style suppressible [S1].
- FACT: Review tiers Base / Plus / Apex / Auto; Auto picks a tier from PR size, risk and complexity [S1]. Each PR gets a 0-5 confidence score, a summary, and diagrams [S4].
- FACT: T-Rex (beta) writes targeted tests, runs them in a sandbox, and attaches logs, traces or screenshots to failing comments [S1].
- FACT: Auto-approve (beta) approves only PRs with a clean 5/5 review, below a configured risk cap and filtered by label, branch, file or author [S1].

**Indexing / code graph**
- FACT: Parses every file into entities (directories, files, functions, classes, variables). It links them through calls, imports and variable usage, then stores the graph for querying at review time [S5]. Uses it to surface impacted callers and cross-file inconsistencies [S1].

**Agents / architecture**
- FACT: v2 was a fixed flowchart (diff, then codebase context, then external context, then comments). v3 is a tool-using loop with codebase search and learned rules that recursively follows nested calls and git history [S2].
- FACT: v3 raised the action rate from 34.75% to 59.24%. It uses about 3x more context tokens but cuts inference cost 75% for self-hosted customers through cache hits [S2]. Marketing describes "parallel agents" or a "swarm" [S4].

**Rules & learning**
- FACT: Uses `greptile.json` per-repo rules and `./greptile/rules` scoped to file patterns, and can link a style guide [S1][S4].
- FACT: Learns from team PR comments, replies to Greptile, and thumbs reactions. It also checks whether a comment was addressed between the first and last commit, and reduces that comment type if not [S6].

**Self-host**
- FACT: Self-hosting is available on the Enterprise plan [S3].

**Pricing (2026-10-11)**
- FACT: Starter is free for 1 developer with 50 credits. Pro is $30 per seat per month with 50 credits per seat, plus $1 per extra credit. A Base review costs 1 credit, Plus 3, and Apex 10. Enterprise is custom. A seat is any developer who got a review in the billing period [S3].

**Borrow (PROPOSAL)**
- Build an agent loop over a symbol graph, not a fixed pipeline.
- Use "comment addressed between first and last commit" as an implicit feedback label.
- Offer risk-tiered review depth with credit pricing.
- Prompt-cache the repo context.

---

## 2. CodeRabbit

**How review works**
- FACT: The PR pipeline is "non-linear" and pulls dozens of context points. Every suggestion goes through multi-step verification and is withheld until the whole pipeline finishes, then delivered as one batch to cut noise [S13].
- FACT: Runs 50+ third-party linters and SAST tools (ESLint, Ruff, and others) in sandboxes, auto-selected by language and configured in `.coderabbit.yaml` [S12].
- FACT: Product surface includes Blast Radius (downstream-impact mapping), a security review with reachability, Autofix, and a cloud coding agent [S10][S11].

**Indexing / context**
- FACT: Context sources are learnings, auto-detected rule files (`CLAUDE.md`, `.cursorrules`, `.github/copilot-instructions.md`), linked repositories, MCP servers, web search, issue trackers (Jira, Linear, GitHub, GitLab), and past PRs [S8].
- PROPOSAL: No public statement of a persistent symbol graph comparable to Greptile's was found in the sources read. Treat this as unverified.

**Rules & learning**
- FACT: "Learnings" are natural-language preference records created from `@coderabbitai` chat. The bot announces them with a "Learnings added" section. They are scoped to a repo or the org, can match path patterns, and are editable [S7].
- FACT: Path-based review instructions cover formal standards [S7][S11]. Setting `knowledge_base.opt_out: true` irrevocably deletes stored learnings [S8].

**Self-host**
- FACT: Self-hosting is Enterprise-only and requires 500+ seats. It supports bring-your-own LLM and works with GitHub, GitLab, Azure DevOps and Bitbucket Data Center [S9].

**Pricing (2026-10-11)**
- FACT: Prices per developer per month:
  - Essentials: $24 billed annually, $30 monthly.
  - Team: $48 annually, $60 monthly.
  - Advanced: $72 annually.
  - Enterprise: custom.
  - Free for OSS.
- FACT: Review rate limits are per developer, with a usage-based add-on for overflow [S11].

**Borrow (PROPOSAL)**
- Make the learnings ledger visible ("Learnings added") and editable.
- Ingest existing agent rule files automatically.
- Run deterministic linters first and let the LLM curate their output.
- Hold all comments until a verification pass completes.

---

## 3. Graphite (Graphite Agent; formerly marketed as "Diamond")

**How review works**
- FACT: Graphite Agent reviews every PR, focuses on real bugs rather than style, and gives actionable fixes [S15]. It is bundled with stacked PRs, a CLI, MCP, and a merge queue [S14].

**Indexing / context**
- FACT: Claims whole-codebase context [S15]. Prompts sent to its LLM subprocessors (Anthropic, OpenAI) include PR metadata, the changed code, related or similar PRs, and related parts of the codebase [S16].
- FACT: Code-indexing controls exist as a plan feature [S14].

**Rules & learning**
- FACT: "Learns from feedback" based on how the team interacts with comments [S15]. AI review customization (rules, filters, automations) is on the Team tier and above [S14].

**Self-host**
- FACT: No self-host option is listed. Enterprise offers GHES support, ACLs, SAML, and an audit log [S14].

**Pricing (2026-10-11)**
- FACT: Prices per user per month, billed annually:
  - Hobby: free, limited AI reviews.
  - Starter: $20, limited AI reviews.
  - Team: $40, unlimited AI reviews.
  - Enterprise: custom.
- FACT: The pricing page shows a "Cursor Cloud Agents are now in Graphite" banner and links sales contact to cursor.com [S14].
- PROPOSAL / inference: Graphite appears to be part of, or tightly integrated with, Cursor. Corporate status was not verified from a primary announcement. The "Diamond" name was not found on current pages.

**Borrow (PROPOSAL)**
- Retrieve similar past PRs as review context.
- Put review in the stacked-PR and merge-queue workflow, not as a standalone bot.
- Make AI features opt-in per org for privacy-sensitive buyers.

---

## 4. CodeScene

**How review works**
- FACT: Runs a fully automated PR/MR review with quality gates for Code Health issues and user-defined goals. It also has a "Virtual code review" for hotspots [S17].
- FACT: The CodeHealth MCP server gives coding agents a deterministic Code Health review. On a regression, the agent is told to refactor until the score is restored, targeting 10.0 [S17].

**Indexing / analysis**
- FACT: Uses behavioural analysis of version-control history: hotspots (most-changed files) combined with the Code Health metric and social or team data [S17][S19].
- FACT: ACE auto-refactoring uses the Code Health metric to steer LLMs (OpenAI, Anthropic, Google), picking a model by code smell and language [S18].

**Rules & learning**
- FACT: Uses Code Quality Profiles (predefined or custom) and goals such as "Supervise" or "Planned Refactoring" [S17].
- PROPOSAL: Learning is metric-driven and configured, not learned from comments. No feedback-learning claim was found.

**Self-host**
- FACT: An on-premises version exists [S19].

**Pricing (2026-10-11)**
- FACT: Tiers are keyed on active authors; enterprise starts at "100+ active authors". ACE pricing is through sales [S17][S18].
- PROPOSAL: Exact per-author prices were not extracted. Mark as unverified.

**Borrow (PROPOSAL)**
- Pair a deterministic maintainability score with the LLM review so gates are reproducible.
- Weight findings by churn hotspots from git history.
- Expose the review as an MCP tool that coding agents call before the PR.

---

## 5. Semgrep (Code + Multimodal, formerly Assistant)

**How review works**
- FACT: Deterministic SAST rules produce findings. Multimodal adds AI detection of business-logic flaws such as IDOR and broken authz, explanations, autotriage, and suggested fixes. Autofix opens PRs [S20].
- FACT: Noise filtering (beta) uses AI to suppress PR comments for likely false positives. Suppressed items stay reviewable in a pre-production backlog, and Block-mode rules still comment [S20][S21].

**Indexing / analysis**
- FACT: Pro rules support cross-file analysis and cross-function taint analysis [S22]. The AI sends only part of the file containing a finding to the model vendor [S22].

**Rules & learning**
- FACT: Autotriage uses the org's code and triage history [S20].
- FACT: "Memories" are admin-written or suggested from triage reasons. They are scoped per project, rule, or vulnerability class and steer remediation guidance [S21].
- FACT: Reports 96% human-agree and an average 60% of findings filtered across 3500+ customers (as of 2025-08-21), measured by thumbs feedback plus an internal expert benchmark [S23].

**Self-host**
- FACT: Supports on-prem source control and optional dedicated infrastructure on Enterprise. AI runs via Semgrep infrastructure [S22].
- PROPOSAL: The OSS CLI can run anywhere, but AI features are SaaS-tied (inference from [S22]).

**Pricing (2026-10-11)**
- FACT: Code costs $30 per contributor per month, Supply Chain $30, and Secrets $15. Teams get 20 AI credits per developer per month; Enterprise gets 50 [S22].
- FACT: A free tier exists [S22]. A contributor is anyone with at least one commit in the past 90 days [S22].

**Borrow (PROPOSAL)**
- Let deterministic rules decide what is flagged and the LLM decide whether to post it.
- Keep suppressed findings auditable.
- Scope memories per rule or vulnerability class.
- Publish an agree-rate metric with its method.

---

## 6. Snyk (Snyk Code / DeepCode AI / Agent Fix)

**How review works**
- FACT: Snyk Code is developer-first SAST in the IDE, repo, and CI, with an AI-based engine and a Priority Score [S24].
- FACT: Snyk Agent Fix (formerly DeepCode AI Fix) generates fixes in this order [S25]:
  1. Static analysis finds the issue.
  2. Relevant CWE examples are retrieved from more than 35k expert-written fix pairs.
  3. The LLM generates k candidate fixes.
  4. SAST re-scans each candidate to confirm the issue is gone with no new one.
  5. If a candidate fails, the error is fed back and the fix is retried.

**Indexing / analysis**
- FACT: DeepCode AI combines symbolic and generative AI ("hybrid AI"). It is built on 25M+ dataflow cases and trained on permissively licensed OSS fixes, never customer data [S27].

**Agents / architecture**
- FACT: In 2026, Agent Fix moved from fine-tuning to dynamic few-shot prompting with an agentic retry. It is benchmarked on Pass@1 and Pass@5 [S25][S26].

**Rules & learning**
- FACT: DeepCode AI Search lets users write custom queries and rules [S27].
- PROPOSAL: No per-team learning-from-comments claim was found.

**Self-host**
- FACT: Snyk Broker, an open-source proxy, connects the SaaS to on-prem or private SCM on Enterprise plans [S29].
- PROPOSAL: Analysis remains SaaS. A full on-prem engine was not verified.

**Pricing (2026-10-11)**
- FACT: Enterprise is credit-based; Code costs 1.0 credit per active contributor per day. A free tier and flat-rate small-team plans exist [S28].

**Borrow (PROPOSAL)**
- Use a verify-by-rescan loop for any AI fix: the static check must pass before it is posted.
- Retrieve curated fix examples by CWE or rule instead of fine-tuning.

---

## 7. Qodo (Qodo Merge) + PR-Agent (open source)

**How review works**
- FACT: Specialized agents (correctness, standards, architecture, risk) run in parallel. A judge agent merges, dedupes, and drops low-confidence findings [S33].
- FACT: Finding types are bugs, rule violations, requirement gaps against linked tickets, UX deviations against Figma, cross-repo breaking changes, and skill findings [S34].
- FACT: The OSS PR-Agent uses a single LLM call per tool (`/review`, `/improve`, `/ask`), takes about 30 seconds, and uses JSON-based prompting configured in `configuration.toml` [S30].

**Indexing / context**
- FACT: Draws on four context sources: the full codebase, PR history, tickets, and org standards [S34].
- FACT: The Context Engine indexes PR history. Findings resembling ones the team usually fixed are boosted; ones often dismissed are quieted. Indexing runs incrementally on merge [S35].
- FACT: PR-Agent compression ranks files by repo language, drops deletion-only hunks, and fits patches by token count with tiktoken [S32].

**Rules & learning**
- FACT: Review Standards are built from the codebase, PR history, and requirements. Rule Miner turns recurring PR patterns into enforced rules [S33].
- FACT: "Advanced self-learning" is Enterprise-only [S36].

**Self-host**
- FACT: PR-Agent is MIT-licensed [S31]. It runs as a CLI, GitHub Action, or Docker image on GitHub, GitLab, Bitbucket, and Azure DevOps [S30]. It is now a community-maintained legacy project, distinct from Qodo's product [S30].
- FACT: Qodo Enterprise offers BYOK, single-tenant SaaS, and on-prem or air-gapped deployment [S36].

**Pricing (2026-10-11)**
- FACT: Pro Team is $30 with credit packs (about $0.012 per credit, pooled, designed for up to 30 users). Enterprise is custom for 30+ users. A free OSS program exists [S36].

**Borrow (PROPOSAL)**
- Fork or read PR-Agent (MIT) for git-provider adapters and its diff-compression algorithm.
- Use a parallel-specialists plus judge pattern.
- Use PR-history "fixed vs dismissed" as a relevance prior.
- Use requirement-gap checks against linked tickets.

---

## 8. Sourcegraph Cody (+ Amp)

**How review works**
- FACT: Cody is an IDE and web assistant (chat, auto-edit, prompts) on Sourcegraph Enterprise. It pulls context from local and remote repos through Sourcegraph's Search API [S37].
- FACT: Amp is a separate multi-model coding agent with per-thread cloud machines ("orbs") [S39]. Its review panel in VS Code gives an AI summary, a guided tour with a recommended file reading order, and navigable full diffs for agent-generated code [S40]. Amp Free (ad-supported) is paused [S41].
- PROPOSAL: Neither product was confirmed as an automated PR-review bot from the sources read. They are relevant as context-retrieval and human-review UX references.

**Indexing**
- FACT: Uses Sourcegraph code search and symbol infrastructure [S37].

**Self-host**
- FACT: Sourcegraph Enterprise can be self-hosted or run on Sourcegraph Cloud [S38].

**Pricing (2026-10-11)**
- FACT: Cody requires Sourcegraph Enterprise [S37].
- PROPOSAL: The public price was not extractable (the pricing page rendered empty). Unverified.

**Borrow (PROPOSAL)**
- Use a review "tour" with a recommended file order for human reviewers.
- Use code search as the retrieval backbone for agent tools.

---

## 9. Cursor Bugbot

**How review works**
- FACT: Reviews PRs for bugs, security, and quality on GitHub, GitLab (including self-hosted), Bitbucket, and Azure DevOps. It posts a check status and reads existing PR comments to avoid duplicates [S42].
- FACT: Can be run pre-push from the agent with `/review-bugbot` [S42]. Autofix spawns a Cloud Agent to fix findings [S42].

**Agents / architecture**
- FACT: v1 ran this pipeline [S43]:
  1. Eight parallel passes over a randomized diff order.
  2. Clustering of similar findings.
  3. Majority vote.
  4. Merge of each cluster into one description.
  5. Category filtering.
  6. A validator model to remove false positives.
  7. Dedupe against earlier runs.
- FACT: Later moved to a fully agentic design with dynamic context discovery, which brought the largest gains. Uses aggressive prompts because the agent proved too cautious [S43].
- FACT: The north-star metric is "resolution rate": an LLM judges at merge whether each flagged bug was fixed. It rose from 52% to over 70%. Offline evaluation uses BugBench. Bugbot handles 2M+ PRs per month [S43].

**Rules & learning**
- FACT: Rule merge order is Team Rules, then `.cursor/BUGBOT.md` (root plus nested, found by walking up from changed files), then learned rules, then manual rules. Limits are 30k characters per rule and 100k combined [S42].
- FACT: `bugbot run verbose=true` lists the rules used [S42]. Learned rules are generated from repo activity or backfilled. `@cursor remember [fact]` adds a rule, and Cursor auto-enables or disables learned rules over time [S42].

**Self-host**
- FACT: SaaS only, though it supports GitLab Self-Hosted as a source [S42].

**Pricing (2026-10-11)**
- FACT: Usage-based on Individual plans; included on Teams at $40 per user per month. Autofix bills Cloud Agent usage [S44][S42]. Third-party models are billed at API price [S45].

**Borrow (PROPOSAL)**
- Use resolution rate as the main quality metric.
- Use multi-pass voting plus a validator as a precision layer.
- Use nested rule files discovered from changed paths, with a verbose rule-usage dump.

---

## 10. Sweep

- FACT: The `sweepai/sweep` repo now states the team pivoted to a JetBrains AI coding assistant [S46]. The `sweep.dev` and `docs.sweep.dev` domains did not resolve on 2026-10-11 (observed during fetch; no citable page).
- PROPOSAL: Sweep is no longer a PR-review competitor. Its historic issue-to-PR bot is out of scope. No pricing or self-host data is relevant.
- Borrow (PROPOSAL): Nothing current. This is a cautionary example of how fragile a standalone GitHub bot is as a business.

---

## 11. Ellipsis

**How review works**
- FACT: Repositioned as an "Agents as a Service" platform, with code review as one use case [S47].
- FACT: Code review is declared in `.ellipsis/code-review.yaml` as multiple reviewers, each with its own prompt, model (Claude Code or Codex), `paths` filter, environment, and budget. The output is one combined review per push [S49].
- FACT: Each reviewer sees only commits it has not reviewed before. Comments are marked blocking or not. `on_pass` / `on_fail` map to approve, request-changes, or comment [S49].

**Indexing**
- PROPOSAL: No dedicated code graph was found. It relies on the agent (Claude Code or Codex) exploring a sandbox checkout (inference from [S49]).

**Rules & learning**
- FACT: Uses a shared skills library and YAML agents in the repo, deployed through PRs [S48].
- PROPOSAL: No feedback-learning claim was found.

**Self-host**
- FACT: Offered as managed SaaS or BYOC in the customer's AWS VPC, with full features in both. Uses scoped per-session credentials and zero source retention [S47][S48].

**Pricing (2026-10-11)**
- FACT: $0 per seat. Tokens are billed at cost plus a 10% platform fee; compute is $0.142 per vCPU-hour and $0.024 per GB-hour [S48].

**Borrow (PROPOSAL)**
- Use a declarative, path-scoped reviewer config in the repo, with per-reviewer budgets.
- Review incrementally per push.
- Offer a blocking flag mapped to the GitHub review state.
- Offer BYOC (customer VPC) as the self-host story.

---

## Comparison table (2026-10-11)

| Vendor | Review style | Context / index | Learning from feedback | Self-host / on-prem | Pricing model |
|---|---|---|---|---|---|
| Greptile | Agent loop + tiers; sandbox tests (beta) [S1][S2] | Repo entity/call graph [S5] | Comments, replies, reactions, addressed-or-not [S6] | Enterprise [S3] | $30/seat + credits [S3] |
| CodeRabbit | Non-linear pipeline + verification; 50+ linters [S12][S13] | Multi-source KB, past PRs, multi-repo [S8] | Chat "learnings", editable [S7] | Enterprise, 500+ seats, BYO LLM [S9] | $24-72/dev/mo [S11] |
| Graphite Agent | Bug-focused PR review in stacking workflow [S14][S15] | Codebase + similar PRs [S16] | "Learns from feedback" [S15] | Not listed (GHES only) [S14] | $20/$40 per user [S14] |
| CodeScene | Code Health gates + MCP refactor loop [S17] | Git behavioural / hotspots [S19] | Configured profiles (PROPOSAL: none) | On-prem version [S19] | Active-author tiers [S17] |
| Semgrep | SAST rules + AI triage/noise filter [S20] | Cross-file taint (Pro) [S22] | Memories + triage history [S21] | On-prem SCM, dedicated infra [S22] | $30/contributor + AI credits [S22] |
| Snyk | SAST + verified agentic autofix [S25] | Hybrid symbolic/ML dataflow [S27] | (PROPOSAL: none found) | Broker proxy [S29] | Credits per contributor-day [S28] |
| Qodo / PR-Agent | Parallel agents + judge; OSS single-call [S30][S33] | Codebase + PR-history index [S35] | Fixed-vs-dismissed prior, Rule Miner [S33][S35] | OSS MIT; Ent on-prem/air-gap [S31][S36] | $30 + credits [S36] |
| Sourcegraph Cody/Amp | IDE assistant; Amp review panel [S37][S40] | Sourcegraph search [S37] | n/a | Self-hosted Sourcegraph [S38] | Enterprise (unverified) |
| Cursor Bugbot | Agentic; earlier 8-pass vote + validator [S43] | Dynamic context discovery [S43] | Learned rules, `@cursor remember` [S42] | No [S42] | Teams $40 / usage-based [S44] |
| Sweep | Pivoted away [S46] | n/a | n/a | n/a | n/a |
| Ellipsis | Declarative multi-reviewer YAML [S49] | Agent in sandbox (PROPOSAL) | (PROPOSAL: none found) | BYOC AWS VPC [S48] | Tokens + 10% [S48] |

---

## Borrow list (all PROPOSAL)

1. **Agent loop over a symbol graph.** Build an agent loop with tools (search, graph query, git history), not a fixed pipeline. Greptile v3 and Bugbot both report their largest gains from this switch [S2][S43].
2. **Precision layer.** Use parallel passes or specialists, cluster and vote, then run a judge or validator, then dedupe against earlier runs [S33][S43].
3. **Deterministic first, LLM curates.** Run linters and SAST, then let the LLM triage and decide whether to post. Keep suppressed items auditable [S12][S20][S21].
4. **Verify fixes mechanically.** Re-run the static check or tests on every suggested fix before posting it, and retry on failure [S1][S25].
5. **Implicit feedback signals.** Track whether a comment was addressed at merge (resolution rate) and whether similar findings were fixed or dismissed in PR history. These beat thumbs reactions [S6][S35][S43].
6. **Visible, editable memory.** Show "Learnings added" in replies, support `remember` commands, scope memories per rule or path, and dump the rules used per run [S7][S21][S42].
7. **Rule ingestion.** Read `CLAUDE.md`, `.cursorrules`, and nested `*.md` rule files found by walking up from changed paths, with character caps [S8][S42].
8. **Repo config as code.** Path-scoped reviewers with per-reviewer model and budget, blocking flags mapped to the GitHub review state, and incremental review per push [S49].
9. **Risk-tiered depth + credits.** Auto-select review depth by PR risk, price by credits, and allow auto-approve only for clean low-risk PRs [S1][S3].
10. **Self-host story.** Offer BYOC or a customer-VPC deployment with BYO LLM. Competitors gate this to Enterprise, and CodeRabbit to 500+ seats, so offering it lower down is a wedge [S9][S36][S48].
11. **OSS head start.** Study or borrow PR-Agent (MIT) for git-provider adapters and diff compression [S31][S32].
12. **Publish metrics with method.** Publish resolution rate and agree rate with a written methodology, as Semgrep does [S23] and as Cursor does with resolution rate [S43].
