# Architecture Decision Records

Format: MADR (Status, Context, Decision, Alternatives considered, Consequences).

| ADR | Title | Status |
|---|---|---|
| [0001](0001-language-runtime.md) | Language and runtime: TypeScript on Node 24 with pnpm workspaces | Accepted (PROPOSAL) |
| [0002](0002-queue.md) | Job queue: BullMQ on Redis/Valkey | Accepted (PROPOSAL) |
| [0003](0003-vector-store.md) | Database and vector store: PostgreSQL 16 + pgvector (HNSW) | Accepted (PROPOSAL) |
| [0004](0004-ast-parsing.md) | Code understanding: tree-sitter symbol graph with optional SCIP | Accepted (PROPOSAL) |
| [0005](0005-sandboxing.md) | Sandboxing: Docker + gVisor (self-host), Firecracker microVMs (SaaS) | Accepted (PROPOSAL) |
| [0006](0006-model-routing.md) | Model routing: OpenAI-compatible provider abstraction with tier policy | Accepted (PROPOSAL) |
| [0007](0007-multi-tenant-isolation.md) | Multi-tenant isolation: RLS, envelope encryption, per-tenant prefixes | Accepted (PROPOSAL) |

New ADRs: copy an existing file, take the next number, never edit an accepted ADR's decision; supersede it instead.
