# 05 — Scoring: measuring review quality

Labels: **FACT** = a claim backed by a cited source in [`SOURCES.md`](./SOURCES.md). **PROPOSAL** = our design choice. It is not verified externally.

## 1. Existing benchmarks and metrics

**FACT**
- **CodeReviewer** (Li et al. 2022) [S150]
  - Built a nine-language dataset of real changes and reviews.
  - Defined three tasks: code change quality estimation, review comment generation, code refinement.
  - Comment generation was scored against human references with text-similarity metrics.
- **CRScore** [S152]
  - Argues review is one-to-many (many valid reviews per diff), so reference-based metrics are inadequate.
  - Proposes a reference-free metric grounded in claims and smells found by LLMs and static analyzers.
  - 0.54 Spearman correlation with human judgment; releases 2.9k human-annotated scores.
- **SWR-Bench** [S153]
  - 1,000 manually verified PRs with full project context.
  - Scoring checks whether issues from a structured ground truth are covered by the review, using an LLM judge with ~90% agreement with humans.
  - Current tools underperform, and multi-review aggregation boosts F1 by up to 43.67%.
- **ContextCRBench** [S154]
  - 67,910 context-enriched entries with hunk-level quality assessment, line-level defect localization and line-level comment generation.
  - Textual context (issues, descriptions) helps more than code context alone.
- **SWE-bench** [S146] and **SWT-Bench** [S145] are execution-based benchmarks: success is judged by running tests. They measure repair and test generation, not review, but they are the model for reproducible, execution-grounded scoring.
- **Greptile's 2025 benchmark** [S155]: 5 tools × 50 real bugs from 5 public repos, measuring catch rate, comment quality, noise and time. It is **vendor-run**, so treat it as a protocol reference, not neutral results.
- **Industry outcome metrics.**
  - Resolution rate: 73.8% of automated comments were resolved in an industrial study [S151], alongside longer PR closure times.
  - Target precision as an operating point: 50% at Google [S130].
- **Security-detection evaluations** are inflated by dataset quality problems (duplicates, label noise). PrimeVul shows the drop under realistic splits [S125].

## 2. Metric set

**PROPOSAL**

### 2.1 Offline (labelled eval set)
| Metric | Definition | Notes |
|---|---|---|
| **Recall@PR (bug catch rate)** | labelled bugs matched by ≥1 finding ÷ labelled bugs | Match = same file and within ±3 lines of the ground-truth location, plus judge-confirmed same issue (SWR-Bench style [S153]) |
| **Precision** | findings judged valid ÷ findings posted | Valid = matches a labelled bug, or a human/LLM-judge confirms it as a real issue not in the labels (labels are incomplete) |
| **Severity-weighted recall** | Σ w(sev) · caught ÷ Σ w(sev) | w: critical 8, high 4, medium 2, low 1 |
| **FP rate per PR** | invalid findings ÷ PRs | The user-facing noise number; target ≤0.5 at launch |
| **F1 / F0.5** | standard | F0.5 is the headline metric because precision matters more for adoption [S130][S151] |
| **Security subset** | precision/recall on the CVE-backed subset; CWE-Bench-Java-style [S124] plus PrimeVul-style dedup [S125] | Reported separately |
| **Comment quality** | CRScore-style conciseness, comprehensiveness and relevance [S152] | Secondary; never used as the gate |

### 2.2 Online (production)
- **Acceptance rate:** 👍 ÷ (👍 + 👎).
- **Resolution rate:** comments followed by a code change touching the commented range within the PR [S151]. "Resolved without change" is counted separately as a weak negative.
- **Time-to-first-review:** p50 and p95 from webhook to first comment. SLO p95 ≤ 5 min for PRs ≤ 1k changed lines.
- **PR cycle-time delta** vs a matched pre-adoption baseline, to catch the regression seen in [S151].
- **Cost per PR:** tokens × price + sandbox minutes, tracked per tier and per tenant.

### 2.3 Reproducibility
- Every eval run pins:
  - model ID and version (or the provider's dated snapshot)
  - prompt template hash
  - index snapshot (commit SHA → blob map)
  - Semgrep version and ruleset hash
  - sandbox image digest
  - temperature (0 for scoring runs where the provider allows it)
- Run each config **3×**. Report the mean ± stdev. A change "wins" only if the gain exceeds 2σ on the headline metric.
- The LLM judge is itself versioned and periodically audited against a human-labelled slice (≥100 items per quarter). Report judge-human agreement, the SWR-Bench practice [S153].

## 3. Eval dataset construction

**PROPOSAL**
1. **Public mined set.**
   - Fix commits in permissively licensed repos, linked to issues.
   - The *bug-introducing* PR becomes the review target, and the fix location becomes the ground truth (SZZ-style back-tracing).
   - Deduplicate across forks.
2. **Seeded set.** Inject realistic bugs into clean PRs. Keep the bug classes realistic: off-by-one, null-handling, auth-check removal, unit mismatch, cross-file arity break. This gives exact labels.
3. **Public benchmarks.** Run SWR-Bench [S153] and the ContextCRBench line-level tasks [S154] for comparability. Re-run the Greptile protocol [S155] ourselves on its public PRs.
4. **Tenant shadow eval** (opt-in only): replay a tenant's own merged PRs that later received fix commits.

## 4. Regression gate

**PROPOSAL** — CI job (Vitest-driven harness, doc 07) on any prompt, model or routing change:
- Block the change if F0.5 drops by more than 1σ, if security-subset recall drops at all, or if FP/PR rises by more than 10%.
- Report cost and latency deltas alongside quality. A cheaper model routing ships only if quality holds within tolerance.
