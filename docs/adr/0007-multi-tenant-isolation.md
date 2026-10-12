# ADR 0007: Multi-tenant isolation: RLS, envelope encryption, per-tenant prefixes

- Status: Accepted (PROPOSAL until Phase 0 exit)
- Date: 2026-10-11
- Related: [ARCHITECTURE.md](../ARCHITECTURE.md), [PLAN.md](../PLAN.md)

## Context

Tenants entrust us with private source code. A single bug in query scoping must not leak data across tenants. SaaS shares infrastructure; enterprise tenants require BYOK and key revocation.

## Decision

- Postgres RLS on every tenant table using tenant_id; policy tenant_id = current_setting('app.tenant_id')::uuid; FORCE ROW LEVEL SECURITY; services use a non-owner role without BYPASSRLS; @platform/db only exposes a withTenant(tenantId, fn) transaction helper that runs SET LOCAL.
- Envelope encryption: per-tenant KEK in cloud KMS (Vault transit or HSM in self-host, BYOK supported); per-object DEKs; encrypts installation tokens, source blobs, Chunk text, retained prompts/responses. DEK cache TTL <= 5 min so revocation takes effect quickly.
- Per-tenant prefixes: BullMQ keys t:{tenantId}:..., object keys tenants/{tenantId}/..., with per-tenant rate-limit groups for fairness.
- Sandbox runs never mix tenants (ADR 0005). Telemetry exports hash tenant IDs and never include code.
- AuditLog is append-only and tenant-scoped.

## Alternatives considered

- **Database per tenant**: strongest isolation, high ops cost at thousands of tenants; reserved for self-host (single tenant by construction) and possibly top-tier SaaS.
- **Schema per tenant**: migration fan-out pain, weak gain over RLS.
- **App-level WHERE tenant_id only**: one missed clause leaks data.
- **Single platform-wide encryption key**: no BYOK, no crypto-shredding per tenant.

## Consequences

- Positive: defense in depth (RLS + encryption + prefixes); crypto-shredding on tenant offboarding via KEK deletion.
- Negative: RLS adds planner overhead and requires discipline with connection pooling (transaction-mode pooling plus SET LOCAL only); KMS latency and cost (mitigated by DEK cache); embeddings remain unencrypted at application level.
- CI gate: automated cross-tenant access test for every tenant table (Phase 0 exit criterion).
