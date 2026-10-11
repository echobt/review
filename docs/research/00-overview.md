# 00 — Research overview: AI code review + security platform

Labels: **FACT** = a claim backed by a cited source in [`SOURCES.md`](./SOURCES.md) (IDs S100–S199). **PROPOSAL** = our design choice. It is not verified externally.

## Problem

**PROPOSAL**
- We are building a Greptile/CodeRabbit-class service. It reviews pull requests with whole-repository context, finds logical and security bugs (including multi-file bugs), proposes verified tests, and runs as SaaS, single-tenant or air-gapped self-host.

**FACT**
- Current automated reviewers underperform on realistic, full-context benchmarks [S153].
- In industrial use, LLM review comments are often resolved (73.8%), but noisy comments can lengthen PR cycle time [S151].
- LLM-only vulnerability detection collapses under realistic evaluation [S125].
- LLM + static analysis hybrids do better than either alone [S124].

## Goals

**PROPOSAL**
1. High-precision PR review: target ≥70% precision on bug findings and ≤0.5 false positives per PR, with severity-weighted recall tracked.
2. Repository-aware context: a symbol graph plus hybrid retrieval, updated incrementally on every push.
3. Security: a deterministic SAST floor (Semgrep OSS), secret and dependency scanning, and LLM triage.
4. Autonomous, sandboxed test generation that keeps only tests that pass and increase coverage.
5. Enterprise deployability: SOC 2 Type II controls, BYO LLM, data residency, zero-retention mode, air-gap.
6. Reproducible quality measurement that gates every prompt, model or routing change.

## Non-goals

- **No frontend in this repo.** This repo holds the backend (API, workers) and TypeScript SDKs only. Any dashboard UI lives elsewhere and consumes the API.
- No model training or fine-tuning on customer code (opt-in research only, out of v1 scope).
- No auto-merge or auto-push to customer branches. Suggestions are applied only by explicit user action.
- No IDE plugin in v1.

## Summary of findings

| Doc | Key findings (FACT) | Key decisions (PROPOSAL) |
|---|---|---|
| [01 — Competitors](./01-competitors.md) | Written by another worker; see that doc. | — |
| [02 — Context indexing](./02-context-indexing.md) | Repo graphs help agents [S110]. AST chunking beats line chunking [S111]. Stack graphs are file-incremental and need no build [S100]. pgvector HNSW limits and filtered-search caveats [S115]. | tree-sitter graph by default, SCIP overlay where buildable. Hybrid vector + BM25 + graph retrieval with RRF. Blob-SHA-keyed incremental index; a push costs well under $0.01 (estimate). |
| [03 — Review engine](./03-review-engine.md) | Intrinsic self-correction is unreliable [S128]; tool-grounded critique works [S129]. Precision-calibrated suggestions at Google [S130]. Multi-agent systems cost ~15× tokens [S133]; a simple pipeline beat agents [S134]. | Fixed workflow per seat, with bounded agent escalation for risky PRs. Semgrep OSS plus LLM triage. Layered FP control: grounding, tool-using verifier, self-consistency, calibrated thresholds, comment budget, feedback suppression. |
| [04 — Test generation](./04-test-generation.md) | TestGen-LLM filters (build, pass reliably, add coverage) [S140]. CoverUp coverage feedback [S141]. ChatUniTest repair loop [S142]. ACH mutation-guided tests [S144]. Tests as a fix filter [S145]. | Plan → generate → sandbox run → repair (≤3 rounds). Keep only deterministic, passing, coverage-increasing tests. Reproducer tests upgrade review findings. |
| [05 — Scoring](./05-scoring.md) | CodeReviewer tasks [S150]; CRScore [S152]; SWR-Bench [S153]; ContextCRBench [S154]; Greptile vendor benchmark [S155]; execution-based SWE-bench [S146]. | Headline F0.5 plus severity-weighted recall, FP/PR, acceptance and resolution rate, latency, cost. 3× pinned runs and a CI regression gate. |
| [06 — Self-host & security](./06-self-host-and-security.md) | SOC 2 trust-services scope [S160][S161]. Bedrock, Azure and Vertex data terms [S162][S163][S164]. RLS bypass rules [S169]. 1-hour GitHub tokens [S172]. Firecracker and gVisor isolation [S173][S175]. | Four deployment modes including air-gap with vLLM/Ollama. RLS + FORCE + per-tenant DEK crypto-shredding. Redact secrets before any LLM call. No-egress sandboxes. |
| [07 — Frameworks](./07-frameworks.md) | Node 24 LTS [S180]; Fastify/zod [S182][S184]; BullMQ flows [S186]; pgvector [S115]. | Fixed stack: TS/Node 24, pnpm, Fastify + zod, BullMQ/Valkey, Postgres 16 + pgvector, tree-sitter + SCIP, gVisor/Firecracker, OpenAI-compatible routing, RLS + KMS, Semgrep OSS, Vitest, OTel. Temporal is a phase-3 candidate. |

## Top risks

**PROPOSAL**
1. **Noise kills adoption** [S151]. Mitigation: precision-first calibration plus a comment budget (doc 03).
2. **Untrusted code execution** (SCIP builds, test generation). Mitigation: microVM/gVisor sandboxes with no egress and no secrets (doc 06).
3. **Benchmark overfitting.** Mitigation: mixed public, seeded and tenant-shadow eval sets, with judge audits (doc 05).
4. **Provider data terms vary.** Vertex ZDR needs explicit configuration [S164]. Mitigation: a per-tenant ZDR posture record (doc 06).

## Index

- [01-competitors.md](./01-competitors.md) (another worker)
- [02-context-indexing.md](./02-context-indexing.md)
- [03-review-engine.md](./03-review-engine.md)
- [04-test-generation.md](./04-test-generation.md)
- [05-scoring.md](./05-scoring.md)
- [06-self-host-and-security.md](./06-self-host-and-security.md)
- [07-frameworks.md](./07-frameworks.md)
- [SOURCES.md](./SOURCES.md)
