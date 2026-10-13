# 04 — Autonomous test generation in a sandbox (TREX-like)

Labels: **FACT** = a claim backed by a cited source in [`SOURCES.md`](./SOURCES.md). **PROPOSAL** = our design choice. It is not verified externally.

"TREX-like" here means a test-generation agent that runs inside the review flow. The design below follows the published literature, not any one vendor's undocumented internals.

## 1. Literature

**FACT**
- **Meta TestGen-LLM** [S140]
  - Improves existing human tests. Every candidate must pass a filter chain (builds, then passes reliably across repeated runs, then increases coverage) before a human sees it.
  - On Instagram Reels/Stories: 75% of candidates built, 57% passed reliably, 25% increased coverage.
  - In test-a-thons it improved 11.5% of the classes it was applied to, and 73% of its recommendations were accepted into production.
- **Meta ACH** (mutation-guided) [S144]
  - Generates a few targeted mutants (simulated faults tied to a concern, such as privacy), then tests that kill them.
  - 10,795 classes, 9,095 mutants, 571 tests; engineers accepted 73% of the tests.
  - An LLM equivalent-mutant detector reached precision 0.79 / recall 0.47, rising to 0.95 / 0.96 with pre-processing.
- **CoverUp** [S141]
  - Iteratively prompts with coverage gaps and feedback.
  - Median per-module line+branch coverage 80% vs CodaMosa's 47%; overall 89% vs MuTAP's 77%.
  - The gains come from the coverage-feedback loop, not only the model.
- **ChatUniTest** [S142]: adaptive focal context plus a **generation → validation → repair** loop. Beat TestSpark/EvoSuite on line coverage in half of the projects.
- **TestPilot** [S143]: JS/npm test generation that repairs failing tests by re-prompting with the error. Effectiveness depends on model size and training data.
- **SWE-bench** [S146]: 2,294 real issue/PR tasks, judged by executing tests. The leaderboards add Verified (500 instances), Lite, Multilingual and Multimodal [S148].
- **SWT-Bench** [S145]: evaluates agents writing issue-reproducing tests, measured by reproduction rate and coverage of the fix. Code-repair agents beat dedicated test-generation tools, and generated tests used as a filter doubled SWE-Agent precision.
- **Stryker** provides mutation testing for JS/TS [S147].

## 2. Goals in this product

**PROPOSAL**
1. **PR-scoped regression tests.** For changed functions with no or weak coverage, propose tests that pass on the PR head and raise coverage of the changed lines.
2. **Bug reproducers, used by the verifier (doc 03).** For a "bug" finding, try to write a test that **fails on the PR head** and makes the claimed failure concrete. A successful reproducer upgrades confidence to ~1.0. This is the SWT-Bench idea of "tests as a filter" [S145].
3. **Mutation hardening (phase 3).** ACH-style targeted mutants for security-sensitive changes, such as removed auth checks [S144].

## 3. Loop

**PROPOSAL**

```
plan ──> generate ──> run in sandbox ──> classify ──┬─> keep (filters pass)
  ^                                                  │
  └──────────── repair (error/coverage feedback) <───┘  (max R=3 rounds, token budget B)
```

1. **Plan.**
   - Detect the test framework from config (`vitest|jest|pytest|go test|junit`).
   - Pick the focal units: changed symbols with low coverage.
   - Gather focal context: signature, dependencies, existing tests of neighbours, fixtures. This is ChatUniTest's adaptive focal context [S142].
   - Output a test plan listing behaviours and edge cases. No code yet.
2. **Generate.** Write test files in the repo's style, placing them where its conventions put tests. Imports are restricted to existing dependencies, and adding packages is forbidden.
3. **Run in the sandbox** (doc 06):
   - gVisor or Firecracker, **no network** (install dependencies in a prior cached layer from the lockfile only)
   - CPU/mem/time limits: 2 vCPU, 4 GB, 10 min
   - read-only repo mount plus a writable overlay
4. **Classify** each test:
   - compile error, runtime failure, assertion failure, flaky (pass/fail differs across N=3 reruns, as in [S140])
   - pass with coverage delta measured on the changed lines
5. **Repair.**
   - Feed back the exact error, or the uncovered lines (CoverUp-style coverage feedback [S141]), plus TestPilot-style error re-prompting [S143].
   - Stop after R rounds or when the budget is exhausted.
6. **Keep filters** — all must hold, mirroring TestGen-LLM's assured filters [S140]:
   - builds
   - passes 3/3 reruns on the PR head (for goal 1)
   - **strictly increases** line or branch coverage of the changed code
   - no new snapshot files
   - no sleeps or timing-based waits (lint check)
   - deterministic: no wall-clock or random use without a seeded RNG
   - for reproducers (goal 2): **fails on the PR head and passes on the base**, or passes after the suggested fix
7. **Optional mutation score.** Run Stryker on the changed functions only [S147]. Prefer tests that kill more mutants when ranking several kept tests.
8. **Deliver.**
   - The PR comment shows the test diff with a "commit suggestion" action.
   - We never push to the customer branch without explicit action.
   - Store the result with the sandbox image digest for reproducibility.

## 4. Budgets and expectations

**PROPOSAL** (estimates)
- Expect the keep rate to sit well below generation volume. Meta's figures, where a quarter of candidates increased coverage [S140], are a realistic prior. Plan for ~3–5 candidates per kept test.
- Per-PR cap: 5 focal units, 3 repair rounds each, 15 sandbox minutes total.
- Tests are generated **asynchronously after the review is posted**. The review latency SLO (doc 05) must not wait for the test-generation job.

## 5. Risks

**PROPOSAL**
- **Executing untrusted repo code** (build scripts, test hooks) is the main security risk. It is mitigated by gVisor/Firecracker, no egress, no secrets in the environment, and ephemeral VMs (doc 06).
- **Tests that encode buggy behaviour.** A test that passes on buggy code locks the bug in. We label these as "characterization tests" and never present them as correctness proofs.
- **Language coverage.** v1 supports TS/JS (Vitest/Jest) and Python (pytest). Others follow based on demand.
