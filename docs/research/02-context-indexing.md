# 02 — Context indexing: repo graph, retrieval, incremental updates

Labels: **FACT** = a claim backed by a cited source in [`SOURCES.md`](./SOURCES.md). **PROPOSAL** = our design choice or estimate. It is not verified externally.

## 1. Why the index matters

**FACT**
- Repository-level tasks require the model to pull together information spread across many files. Iterative retrieval-then-generation beats in-file-only context [S109].
- Adding a repository-level code graph to existing SWE-bench agents improved every method tested [S110].
- LLMs use information placed in the middle of long contexts less reliably. Stuffing the whole repository into the prompt is therefore not free even when the context window is large enough [S113].
- Retrievers struggle when the query and the target share few words, and generators do not always benefit from extra context [S112].

**PROPOSAL**
- The index answers three questions per PR:
  1. What do the changed symbols call?
  2. What calls the changed symbols?
  3. What else in the repository looks like this change, such as conventions and similar bugs?
- Questions 1 and 2 are structural (graph). Question 3 is semantic (embeddings plus lexical search). We build both and merge their results with rank fusion.

## 2. Structural options: AST, call graph, SCIP/LSIF, stack graphs

**FACT**
- **tree-sitter** is an incremental parsing library. It builds concrete syntax trees, updates them efficiently after edits, and still produces useful trees when the code has syntax errors. The runtime is dependency-free C11 [S103], with official WebAssembly bindings (`web-tree-sitter`) [S104].
- **SCIP** is a Protobuf-based index format for go-to-definition, find-references and find-implementations [S105]. Language-specific indexers such as `scip-typescript` [S106] produce it. Indexers usually run the language's compiler or type checker, which is what makes them precise.
- **LSIF** is the older JSON-graph format from the LSP ecosystem [S107]. SCIP is its successor in Sourcegraph's tooling [S105].
- **Stack graphs** resolve names (reference to definition) through path-finding over a graph built from **syntax only**, with no build step or per-package configuration. Graph construction is **file-incremental**, so unchanged files are never re-analysed. Stack graphs power GitHub Precise Code Navigation [S100][S101][S102].
- Aider's "repo map" uses tree-sitter to extract symbols and signatures. It then ranks them with a graph algorithm over the file-dependency graph so the map fits a token budget [S108].

| Approach | Precision | Needs build? | Incremental | Language coverage | Our use |
|---|---|---|---|---|---|
| tree-sitter tags + heuristic name matching | Medium (fails on overloads and dynamic dispatch) | No | Per file [S103] | Very broad | **v1 default** |
| SCIP indexers | High (compiler-grade) | Usually yes (deps installed) | Per project; usually a re-index | Per language indexer | **v1 optional**, enabled per repo where buildable |
| LSIF | High | Yes | Poor | Legacy | Rejected (superseded by SCIP [S105]) |
| Stack graphs | High for languages with rules | No [S100] | Per file [S100] | Limited set of language rules | Phase-2 candidate |

**PROPOSAL**
- **v1 graph = tree-sitter.** For each file we store:
  - definitions: `symbol_id`, kind, fully qualified name guess, byte range, signature, docstring hash
  - references: name, enclosing definition, byte range
  - imports and exports
- Edges `calls`, `imports`, `defines`, `references` are resolved with scope-aware heuristics: import graph first, then same-module names, then a global unique-name fallback. Each edge carries a confidence weight: 1.0 for import-resolved, 0.5 for name-only.
- **SCIP overlay.** When a repo opts into "precise mode" and its build is reproducible inside the sandbox (doc 06), we run SCIP indexers there. SCIP edges replace the heuristic edges for the files they cover.
- **Repo map (Aider-style) [S108]** is a cheap, always-available summary: personalized PageRank over the file graph, seeded by the PR's changed files. It is the "table of contents" given to the review model.

## 3. Chunking

**FACT**
- Line-based chunking breaks semantic units apart. Chunking along AST nodes (recursive split, merge siblings up to a size limit) improved Recall@5 by 4.3 points on RepoEval and Pass@1 by 2.67 on SWE-bench [S111].

**PROPOSAL**
- Chunk unit = the smallest enclosing definition (function, method, class body without members) that fits under **~400 tokens**. Larger definitions are split at child statement blocks, cAST-style [S111]. Small adjacent top-level items such as imports and constants are merged.
- Each chunk embeds a header with path, enclosing symbol chain and signature. This raises lexical overlap with natural-language queries, which retrievers need [S112].
- Not embedded:
  - generated and vendored files: `linguist-generated`, `node_modules`, `dist`, lockfiles
  - files over 1 MB
  - minified code (heuristic: mean line length > 300)

## 4. Embeddings vs lexical vs graph

**FACT**
- pgvector supports HNSW and IVFFlat. HNSW gives a better speed/recall trade-off but builds more slowly and uses more memory.
- `vector` is limited to 2,000 dimensions and `halfvec` to 4,000. Defaults are `m=16` and `ef_search=40`.
- A filtered query can return fewer rows than requested. pgvector mitigates this with **iterative index scans** and partial indexes [S115]. HNSW itself is from Malkov & Yashunin [S114].
- voyage-code-3 offers a 32K context, Matryoshka dimensions (smaller vectors) and int8/binary quantization. The vendor reports it beats OpenAI-v3-large by 13.80% on average across 32 code-retrieval datasets [S116] (vendor-reported).

**PROPOSAL**
- Hybrid retrieval: `score = RRF(vector_topk, bm25_topk, graph_neighbors)`.
  - BM25 uses Postgres full-text search on the identifier-split chunk text.
  - Graph neighbours are 1–2 hops from changed symbols, weighted by edge confidence.
- Embedding dimension 1024 stored as `halfvec`. This halves storage versus `vector` and stays well within the 4,000 limit [S115]. The model is configurable per tenant (BYO provider, doc 06).
- Every vector query filters by `tenant_id` and `repo_id`. We set `hnsw.iterative_scan = relaxed_order` to avoid result starvation under filtering [S115]. Very large tenants get a partial index per tenant.

## 5. Incremental updates on push

**FACT**
- Most commits touch a small fraction of files, so file-incremental indexing amortizes cost [S100][S101].
- tree-sitter re-parses edited files incrementally [S103].

**PROPOSAL** (pipeline, BullMQ jobs — see doc 07)
1. Webhook `push` / `pull_request.synchronize` enqueues `index.diff` with `{repo, before, after}`. It is deduplicated by `(repo, after)`.
2. `git diff --name-status before..after` gives the added, modified, deleted and renamed files.
3. Content-addressed cache keyed by **blob SHA**: parse, chunk and embed are computed once per blob SHA per tenant. A rename or revert costs nothing.
4. For changed files:
   - re-parse and recompute definitions and references
   - delete old edges from or to those files
   - re-resolve edges *into* the changed files from importers; the importers are found through the reverse-import table
5. Embed only new chunk hashes and upsert. Garbage-collect orphaned chunks lazily (nightly).
6. SCIP overlay, when enabled: re-run per affected package, debounced to at most one run per 10 minutes per repo. The heuristic graph serves until the run finishes.
7. A PR review reads the index **at the PR head SHA**. Index rows carry `(blob_sha)` and the snapshot is a `commit -> {path: blob_sha}` mapping, so several branches share rows.

## 6. Cost and latency estimates

**PROPOSAL — all figures are estimates; assumptions stated explicitly.**

Assumptions:
- Average code file ≈ 250 lines ≈ 2,500 tokens, giving ~8 chunks per file at ~300 tokens each.
- Embedding price assumption: **$0.02–0.20 per 1M tokens** (the range spans commodity to premium code-embedding models; verify against the chosen provider's current price sheet).
- tree-sitter parse throughput ≥ 1 MB/s per core. This is conservative and must be measured with the Vitest bench harness.
- 1024-dim `halfvec` = 2 KB per vector, plus HNSW overhead of roughly 1.5–2× (an estimate).

| Repo size | Files | Embedded tokens | Embedding cost (one-off) | Vector storage | Cold index wall time (8 workers) |
|---|---|---|---|---|---|
| Small | 2k | ~5M | $0.10–$1 | ~16k vectors, ~60 MB | ~1–3 min |
| Medium | 20k | ~50M | $1–$10 | ~160k vectors, ~0.6 GB | ~10–25 min (bounded by embedding API rate limits) |
| Large monorepo | 200k | ~500M | $10–$100 | ~1.6M vectors, ~6 GB | hours; needs a provider batch API |

- **Incremental:** a typical push touching 10 files means ~80 chunks, ~25k tokens, well under $0.01, and p50 under 10 s end to end. This is dominated by queueing and embedding round-trips.
- **Query latency target:** p95 < 150 ms for hybrid retrieval with HNSW at `ef_search` 40–100 [S115]. Graph expansion is SQL over adjacency tables with depth ≤ 2.

## 7. Open questions (PROPOSAL)
- Code-specific vs general embedding model: run an A/B on our own eval set (doc 05) before locking a default.
- Stack-graphs adoption depends on which language rule sets are maintained [S102].
- Whether to embed PR/issue history (textual context). ContextCRBench suggests textual context helps review more than code context alone [S154].
