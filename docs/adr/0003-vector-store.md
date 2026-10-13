# ADR 0003: Database and vector store: PostgreSQL 16 + pgvector (HNSW)

- Status: Accepted (PROPOSAL until Phase 0 exit)
- Date: 2026-10-11
- Related: [ARCHITECTURE.md](../ARCHITECTURE.md), [PLAN.md](../PLAN.md)

## Context

We store relational data (tenants, PRs, findings) and embeddings for code Chunks. Retrieval always filters by tenant_id and repo_index_id, and joins to Symbols. Tenant isolation is enforced via RLS (ADR 0007). Self-host must be simple.

## Decision

- PostgreSQL 16 with pgvector; HNSW indexes on Chunk.embedding (cosine), one index per embedding dimension/model.
- Queries filter by tenant_id + repo_index_id; use iterative scan / ef_search tuning to keep recall with selective filters; for very large tenants, partition Chunk by tenant hash (list/hash partitioning) so each HNSW index stays small.
- Embeddings and relational data share transactions and RLS policies.

## Alternatives considered

- **Dedicated vector DB (Qdrant, Weaviate, Milvus, Pinecone)**: better ANN at extreme scale and native filtering, but a second store with its own tenancy model, backup and consistency story; Pinecone unavailable air-gapped.
- **OpenSearch / Elasticsearch kNN**: good hybrid lexical search, heavy to operate.
- **IVFFlat in pgvector**: cheaper build, needs training and re-clustering on change; worse recall under churn.
- **No vectors (symbol graph + lexical only)**: simpler, but loses semantic retrieval for cross-cutting changes.

## Consequences

- Positive: one datastore, RLS applies to vectors, transactional consistency, easy backup.
- Negative: HNSW build is memory-heavy and filtered ANN can lose recall; mitigated by partitioning and tuning. Embeddings are not encrypted at rest beyond disk encryption (needed for ANN).
- Revisit trigger: > 500M Chunks or p95 ANN latency > 100 ms after partitioning.
