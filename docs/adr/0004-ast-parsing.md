# ADR 0004: Code understanding: tree-sitter symbol graph with optional SCIP

- Status: Accepted (PROPOSAL until Phase 0 exit)
- Date: 2026-10-11
- Related: [ARCHITECTURE.md](../ARCHITECTURE.md), [PLAN.md](../PLAN.md)

## Context

Reviews need callers/callees, definitions and type context around changed code across many languages. Running real builds for every repo is slow and fragile; precise compiler-grade indexes are available for some ecosystems.

## Decision

- tree-sitter (native bindings, WASM fallback) parses all supported languages; per-language queries (tags.scm style) extract definitions, references, imports into Symbol rows and a reference graph; Chunk boundaries follow symbols.
- Optional SCIP: if a SCIP index is uploaded from CI or can be built in sandbox-runner (scip-typescript, scip-java, scip-python, etc.), precise references override heuristic name-based edges for that RepoIndex.
- Incremental: re-parse only changed files; graph edges recomputed for affected files.

## Alternatives considered

- **LSP servers at index time**: precise, but need full builds and long-lived processes per repo; costly and flaky multi-tenant.
- **ctags / universal-ctags**: fast, but definitions only, no structured references.
- **Compiler APIs per language (tsc, javac)**: precise, but N bespoke integrations.
- **Pure embeddings, no AST**: loses structural context and line-precise anchoring.

## Consequences

- Positive: broad language coverage, fast, no build needed; precision available where SCIP exists.
- Negative: heuristic refs miss dynamic dispatch and overloads; quality varies per grammar. Grammars and native binaries must be vendored for air-gap.
- Follow-up: measure retrieval recall per language in Phase 1 and prioritize SCIP where tree-sitter recall is weakest.
