# ADR 0006: Model routing: OpenAI-compatible provider abstraction with tier policy

- Status: Accepted (PROPOSAL until Phase 0 exit)
- Date: 2026-10-11
- Related: [ARCHITECTURE.md](../ARCHITECTURE.md), [PLAN.md](../PLAN.md)

## Context

Different tasks have very different quality/cost needs (planning and triage vs deep security review vs judging). Providers have outages and rate limits. Enterprise and air-gapped tenants require specific providers (Bedrock, Azure OpenAI) or local models (vLLM). Costs must be bounded per tenant.

## Decision

- @platform/models exposes chat, structured (zod), and embed calls over the OpenAI-compatible API shape. Adapters: OpenRouter, AWS Bedrock (via OpenAI-compatible gateway or native adapter), Azure OpenAI, vLLM.
- Tiers: cheap, standard, premium, embed. Per-task policy maps task kind to tier; tenant config may override within its plan and restrict allowed providers.
- Cheap tier default: deepseek/deepseek-v4.1-flash via OpenRouter.
- Fallback chain per tier: retry with backoff on 429/5xx, then next provider in same tier, then optional downgrade; every attempt recorded on AgentTask (model_id, tokens, cost).
- Budgets: per-tenant monthly cap and per-ReviewRun cap enforced pre-call using token estimates and post-call reconciliation; on cap, downgrade then stop with partial review flagged.
- Model/prompt changes are gated by scoring-service regression checks (Phase 4).

## Alternatives considered

- **Single provider SDK**: simplest, but single point of failure and no enterprise/air-gap story.
- **LiteLLM proxy**: broad coverage; adds a Python service and another hop; may be adopted as an optional adapter behind the same interface.
- **Provider-native SDKs everywhere**: maximal feature access, N code paths.
- **Static model per task, no tiers**: no cost control or graceful degradation.

## Consequences

- Positive: provider independence, cost control, air-gap via vLLM, measurable quality per model.
- Negative: lowest-common-denominator API (tool calling and structured output vary by provider; mitigate by zod validation + repair retry); OpenRouter adds a data processor to the subprocessor list.
- Requires per-provider zero-retention configuration where offered.
