# 03 — Review engine: diff analysis, multi-file bugs, SAST + LLM, false-positive control

Labels: **FACT** = a claim backed by a cited source in [`SOURCES.md`](./SOURCES.md). **PROPOSAL** = our design choice. It is not verified externally.

## 1. Evidence base

**FACT**
- Pure LLM vulnerability detection is weak once evaluated realistically. On the PrimeVul dataset a 7B model fell from 68.26% F1 (BigVul) to 3.09%, and GPT-3.5/GPT-4 were close to random in the strictest setting [S125].
- **Neuro-symbolic** works better. In IRIS, an LLM infers taint specifications that static analysis (CodeQL) then runs. On a 120-CVE Java benchmark it detected 55 vulnerabilities vs CodeQL's 27, and improved the false-discovery rate by about 5 points [S124].
- Semgrep (CE: LGPL-2.1, many languages, source-like patterns) [S120][S121] and CodeQL ("query code as data") [S123] are the reference deterministic engines.
- Semgrep's commercial product already uses LLM triage. Its "noise filtering" hides likely-false-positive PR comments and routes them to the security team [S122].
- Google's ML comment-resolution system was **calibrated to a 50% target precision**. Raising the target precision shows fewer suggestions; lowering it shows more wrong ones [S130].
- Google's AutoCommenter shows LLM best-practice comments can run at the scale of tens of thousands of developers. Its paper reports deployment challenges [S131].
- In an industrial deployment of an LLM reviewer (Qodo PR-Agent), 73.8% of comments were resolved, but mean PR closure time rose from 5h52m to 8h20m. Developers reported faulty and unnecessary comments [S151].
- On SWR-Bench, current automated review tools underperform, and aggregating multiple reviews raised F1 by up to 43.67% [S153].

## 2. Pipeline

**PROPOSAL**

```
PR event
 ├─ 0. Gate: skip drafts/bots/generated-only diffs; size budget check
 ├─ 1. Diff analysis (deterministic)
 │     hunks -> tree-sitter: changed symbols, signature changes, deleted exports
 ├─ 2. Context assembly (doc 02)
 │     callers/callees of changed symbols (≤2 hops), repo map, similar code, PR text + linked issue
 ├─ 3. Deterministic scanners (parallel, sandboxed)
 │     Semgrep OSS (rulesets + tenant rules) on changed files; gitleaks on diff [S136];
 │     osv-scanner on lockfile changes [S137]
 ├─ 4. LLM review passes (see §4)
 │     a. per-file local review   b. cross-file impact review   c. SAST triage
 ├─ 5. Verification (see §5)  -> drop / downgrade / keep
 ├─ 6. Dedup + rank + budget (max N comments/PR, severity-ordered)
 └─ 7. Post: inline comments + summary; record finding ids for feedback
```

### 2.1 Diff analysis
- Map each hunk to its enclosing definition. Classify each change:
  - signature change
  - control-flow change (conditions, early returns, exception paths)
  - data-contract change (types, schemas, SQL, serialized fields)
  - config, dependency or test-only change
- **Signature or contract change** triggers the cross-file pass: fetch every caller from the graph (doc 02). These are the "multi-file logical bugs", such as a caller still passing the old arity or units, or a nullable return now unchecked.
- **Deleted or renamed exports** are checked against the reference table for dangling uses outside the diff.

### 2.2 Multi-file logical bugs
- Prompt the model with: changed function before/after + top-K callers (ranked by edge confidence and test coverage) + the contracts involved.
- Ask for **specific, falsifiable claims**: "caller X at path:line passes ms where seconds are now expected". Generic advice is rejected (see verifier).
- Keep the context compact and ordered: changed code first, evidence last. This counters the long-context degradation in [S113].

## 3. SAST + LLM hybrid

**PROPOSAL** (Semgrep OSS as the fixed deterministic engine; see doc 07)

| Step | Who | Output |
|---|---|---|
| Detect | Semgrep OSS rules on changed files plus 1-hop importers | raw findings |
| Triage | LLM gets the finding, the dataflow snippet and the sanitizer/caller context | `{verdict: tp/fp/unsure, reason, exploit_path}` |
| Spec-mining (phase 2, IRIS-style [S124]) | LLM proposes repo-specific sources, sinks and sanitizers as Semgrep taint rules | candidate rules, gated by tests on the repo |
| Report | Only `tp`, plus `unsure` at high severity, become PR comments; `fp` go to a security dashboard, as Semgrep does [S122] | comments |

- The deterministic engine guarantees **reproducibility and recall floors**. The LLM is used to **reduce noise and explain**, which avoids the unreliable LLM-only detection reported in [S125].
- CodeQL: optional adapter only. We believe its licence terms restrict use on non-open-source code without GitHub Advanced Security. This was **not verified in this research**; legal must confirm against the current CodeQL terms. Until then, v1 does not bundle it. Customers can import SARIF from their own CodeQL runs.

## 4. Single agent vs swarm, per seat

**FACT**
- Anthropic advises starting with the simplest solution and adding agentic complexity only when it pays off. It describes an **evaluator-optimizer** workflow where one LLM generates and another critiques [S132].
- Multi-agent systems used ~15× the tokens of chat. They beat single-agent by 90.2% on a breadth-first research eval, but are a poor fit for tasks with tight dependencies or shared context [S133].
- A fixed, non-agentic pipeline (Agentless) beat open-source agents on SWE-bench Lite at $0.70 per issue [S134].
- Agent performance depends heavily on the tool interface [S135].

**PROPOSAL**
- **Default per seat = a fixed workflow, not an autonomous swarm.** Passes 4a, 4b and 4c are parallel *workflow steps* with fixed prompts. Code review of a PR is moderately coupled: findings depend on shared context, which is the poor-fit case in [S133].
- **Bounded agent escalation**, for large or risky PRs only (security-sensitive paths, more than N files, or a signature change with more than M callers). A planner splits the review by subsystem into ≤4 sub-reviewers, each with a hard token budget. Expected cost is ~3–5× the base review, so it is gated by tenant plan and budget (doc 07 model routing).
- Tiering (PROPOSAL): a small model for summarization, dedup and lint-like checks; a frontier model for cross-file and security triage; a medium model for the verifier.

## 5. False-positive control

**FACT**
- Intrinsic self-correction **without external feedback** often fails to improve reasoning and can degrade it [S128].
- Critique grounded in **tools** (interpreters, search) does improve outputs [S129]. Self-Refine and Reflexion show gains when the feedback signal is informative [S126][S127].
- Calibrating to a target precision is a production-proven lever [S130].
- Aggregating multiple reviews improves F1 [S153].

**PROPOSAL** — layered filters, cheapest first:
1. **Grounding check (deterministic).**
   - Every finding must cite `path:line` inside the PR diff, or a graph-linked file.
   - Quoted code must match the file byte-for-byte.
   - Otherwise drop.
2. **Verifier agent (tool-grounded, not intrinsic [S128][S129]).** A separate model call gets the finding and may:
   - read files
   - query the graph
   - run Semgrep rules
   - in phase 2, run a generated reproducer test in the sandbox (doc 04)

   Output: `confirmed | refuted | unverifiable` plus a calibrated confidence.
3. **Self-consistency (high-severity only).** Re-run the generating pass with k=3 samples or different models. Keep findings that ≥2 runs agree on; match them by location plus a semantic key. This follows the aggregation result in [S153].
4. **Confidence threshold per category**, calibrated offline on the labelled eval set (doc 05) to a target precision. Starting point: ≥70% precision for "bug" and ≥50% for "suggestion", following the Google precision-target practice [S130]. Thresholds are tunable per tenant.
5. **Comment budget.** At most ~7 inline comments per PR (configurable), ranked by severity × confidence. The rest go into a collapsed summary. This addresses the PR-latency regression and noise reported in [S151].
6. **Feedback learning.**
   - Capture signals: thumbs up/down, "resolved" with a code change at that location (strong positive), "resolved without change" or dismissed (negative), and reply text.
   - Per tenant, store **suppression memories**: embeddings of dismissed findings plus a rule key. A new finding that is ≥0.9 similar to ≥2 dismissals at the same rule key is suppressed. Semgrep ships a comparable "memories" feature [S122].
   - Feed accept/dismiss labels into the threshold re-calibration job weekly.
   - No model fine-tuning on customer data without explicit opt-in (doc 06).

## 6. Output contract

**PROPOSAL** — each finding (zod schema, doc 07):
`{id, rule_key, category: bug|security|perf|maintainability|style, severity: critical|high|medium|low, confidence: 0..1, location: {path, start_line, end_line}, evidence: [{path, line, quote}], explanation, suggested_fix?, verifier: {verdict, model, tools_used}, source: llm|semgrep|gitleaks|osv}`.

- Every finding is stored with the prompt hash, model ID and index snapshot SHA, which makes it reproducible (doc 05).
