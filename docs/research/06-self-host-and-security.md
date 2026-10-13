# 06 — Self-hosting, compliance and security

Labels: **FACT** = a claim backed by a cited source in [`SOURCES.md`](./SOURCES.md). **PROPOSAL** = our design choice. It is not verified externally. Nothing here is legal or audit advice; the auditor decides final control scope.

## 1. SOC 2 Type II

**FACT**
- SOC 2 reports cover controls at a service organization relevant to **Security, Availability, Processing Integrity, Confidentiality or Privacy** [S160].
- These are evaluated against the AICPA Trust Services Criteria [S161].
**PROPOSAL**
- Working definitions, not verified against the AICPA text here: Type I assesses control design at a point in time; Type II assesses operating effectiveness over a period.
- Control map, with in-scope criteria Security + Availability + Confidentiality:
| Area | Control | Evidence source |
|---|---|---|
| Access | SSO + MFA for staff; least-privilege IAM; quarterly access reviews; break-glass audited | IdP logs, review tickets |
| Change mgmt | PR review required; CI (Vitest, Semgrep on our own code); signed images; infra as code | Git history, CI logs |
| Logical isolation | Postgres RLS + per-tenant keys (§5) | Automated isolation tests in CI |
| Encryption | TLS 1.2+ in transit; KMS envelope encryption at rest [S171] | KMS key policies, config scans |
| Logging/monitoring | OpenTelemetry traces + audit log (append-only, 1-year retention) | Log store |
| Vendor mgmt | LLM sub-processors listed with DPAs; ZDR configuration verified (§3) | Vendor register |
| Incident response | Runbook, on-call, 72h customer notification target | Postmortems |
| Data retention | Policy-driven TTL jobs (§4), deletion evidence | Job logs |
| Availability | Multi-AZ Postgres, queue redundancy, tested restore drills | Drill reports |

- The Type II observation window starts only once these controls run continuously. Plan for 3–6 months for the first report.

## 2. Deployment modes

**PROPOSAL**
| Mode | What runs where | LLM |
|---|---|---|
| SaaS (multi-tenant) | Our cloud; Firecracker sandboxes | Our provider accounts or tenant BYO keys |
| Dedicated (single-tenant cloud) | Our IaC in the customer's cloud account | Customer's Bedrock, Azure OpenAI or Vertex |
| Self-host (connected) | Helm chart or docker-compose; gVisor sandboxes | BYO provider endpoint |
| **Air-gapped** | Same images, mirrored to an internal registry; no outbound traffic | **vLLM** or **Ollama** on internal GPUs; local embedding model |

Air-gap requirements:
- All images are signed and listed with digests in a release manifest.
- Semgrep rules, OSV DB snapshots [S137] and tree-sitter grammars are bundled in an offline update bundle.
- No telemetry phones home. OpenTelemetry exports only to a customer collector.
- License checks work offline (signed license file).
- Git access goes through the customer's GitHub Enterprise Server or GitLab only.

## 3. BYO LLM providers

**FACT**
- **Amazon Bedrock:** model providers have no access to Bedrock's deployment accounts, logs, or customer prompts and completions [S162]. Cross-region inference profiles exist, and they matter for residency [S178].
- **Azure (Foundry / Azure OpenAI):** prompts, completions and embeddings are not available to OpenAI or other model providers and are not used to train foundation models. Abuse monitoring applies by default, and eligible customers may apply to modify it [S163].
- **Vertex AI:** reaching zero data retention takes **explicit customer action**. Gemini models cache data in memory by default with a 24h TTL, and prompt logging for abuse monitoring must be addressed [S164].
- **vLLM** exposes an OpenAI-compatible API server [S165]. **Ollama** supports a subset of the OpenAI API [S166].
- **OpenRouter** offers provider routing with fallbacks and data-collection controls [S167], plus a Zero Data Retention routing option [S168].

**PROPOSAL**
- One `LLMProvider` interface over the OpenAI-compatible chat, embeddings and tool-call shapes (doc 07). Native adapters exist only where the wire protocol differs: Bedrock Converse and Vertex.
- A capability probe at configuration time checks tool calling, JSON mode, context length and embedding dimensions. Tiers the provider cannot satisfy are **disabled, not silently downgraded**.
- **ZDR posture per provider** is recorded in the tenant config and shown in the admin UI/API:
  - Azure: the abuse-monitoring exemption status [S163]
  - Vertex: whether caching is disabled and the logging exception is in place [S164]
  - OpenRouter: the ZDR flag [S168]
  - Bedrock: no model-provider access by default [S162]

## 4. Data residency and retention

**PROPOSAL**
- **Residency:** each tenant is pinned to a region (US, EU, ...). The DB, object store, queues and LLM endpoints are all in-region. Bedrock cross-region profiles are allowed only when they stay within the tenant's geography [S178].
- **Retention defaults** (configurable per tenant):
  | Data | Default | Zero-retention mode |
  |---|---|---|
  | Source code blobs | Not stored; fetched per job, deleted at job end | Same |
  | Index (chunks, embeddings, symbol graph) | Kept while the repo is connected; deleted within 7 days of disconnect | Optional: graph only, with no chunk text stored; embeddings derived at query time (higher cost) |
  | Findings and comments | 1 year | 30 days |
  | LLM prompts/responses | Not persisted; only hashes and token counts | Same |
  | Audit logs | 1 year | 1 year (compliance) |
- Deletion is a job with evidence: row counts deleted, object prefixes purged, and **crypto-shredding** by destroying the tenant's data key (§5).

## 5. Tenant isolation

**FACT**
- PostgreSQL RLS policies restrict which rows queries return or affect. **Superusers and `BYPASSRLS` roles always bypass RLS. Table owners bypass it unless `FORCE ROW LEVEL SECURITY` is set** [S169].
- The pool model with policies over `current_setting('app.current_tenant')` is a documented pattern [S170].
- KMS envelope encryption uses a KMS key to wrap data keys, which encrypt the data [S171].

**PROPOSAL**
- **DB:**
  - every tenant table has `tenant_id uuid not null` plus an RLS policy `tenant_id = current_setting('app.tenant_id')::uuid`
  - `FORCE ROW LEVEL SECURITY` is set on all tables [S169]
  - the application role is non-owner, non-superuser and has no `BYPASSRLS`
  - each transaction runs `SET LOCAL app.tenant_id`, so the setting cannot leak across pooled connections
  - migrations run as a separate owner role
- **CI isolation test:** for every table, insert as tenant A, then assert that tenant B sees 0 rows and that writes cross-tenant fail.
- **Encryption:**
  - per-tenant data key (DEK), wrapped by the KMS key (KEK) [S171]
  - sensitive columns (chunk text, finding evidence, tokens) are encrypted at the application layer with the DEK
  - self-host uses a pluggable KMS: AWS KMS, GCP KMS, Azure Key Vault, HashiCorp Vault Transit, or a local file-backed key for air-gap (documented as weaker)
- **Queues and objects:**
  - BullMQ queue names prefixed `t:{tenant}` for heavy tenants; otherwise a shared queue with a tenant-fair-share limiter (doc 07)
  - object keys `tenants/{tenant_id}/...` with per-prefix IAM in SaaS
- **Sandbox:** one microVM or gVisor sandbox per job and never reused across tenants (§7).

## 6. Secret handling

**FACT**
- GitHub App installation tokens **expire after 1 hour** and can be limited to specific repositories and permissions [S172].
- gitleaks is an open-source secret scanner [S136].

**PROPOSAL**
- Prefer GitHub App installation tokens minted per job, scoped to the single repository with `contents:read`, `pull_requests:write` [S172]. Never store long-lived PATs. GitLab uses project access tokens that we rotate.
- Platform secrets (provider API keys, webhook secrets, the GitHub App private key) live in a secret manager. Tenant BYO keys are stored encrypted with the tenant DEK and decrypted only in the worker's memory.
- **Never send secrets to LLMs.**
  1. Run gitleaks over every chunk and diff before prompting [S136].
  2. Redact matches to `«REDACTED:type»`.
  3. Raise a separate "secret committed" finding.
- Sandboxes receive **no** credentials, and egress is denied by default.
- Logs: structured logging with a deny-list of fields. OpenTelemetry span attributes never carry code or prompt text, only hashes and sizes.

## 7. Sandbox isolation

**FACT**
- gVisor is a userspace application kernel written in Go. Its `runsc` OCI runtime integrates with Docker and Kubernetes [S173]. Its security model centres on reducing the host system-call attack surface [S174].
- Firecracker uses KVM microVMs with 5 emulated devices, <125 ms boot and <5 MiB overhead per VM [S175]. It runs AWS Lambda and Fargate in production [S176].
- Kata Containers run containers inside lightweight VMs [S177].

**PROPOSAL** (fixed decision; see doc 07): Firecracker for SaaS, gVisor (`runsc`) for self-host and local. Plain Docker is rejected because a shared host kernel is not acceptable for untrusted build scripts. Kata is a supported alternative for self-hosters already on Kata.
