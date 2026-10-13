import type { Message } from "@review/core";
import { tenantKey } from "@review/queue";
import type { ObjectStore } from "@review/service-common";
import { AgentContext, runAgent, type AgentDeps, type AgentResult } from "./agent.ts";

/** Queue path: load context JSON from the object store, run the agent, write the result JSON next to it. */
export async function handle(deps: AgentDeps & { store: ObjectStore }, msg: Message<"agent.task">): Promise<AgentResult> {
  const p = msg.payload;
  const raw = await deps.store.get(p.contextObjectKey);
  if (!raw) throw new Error(`agent context not found: ${p.agentTaskId}`);
  const result = await runAgent(deps, { tenantId: msg.tenantId, reviewId: p.reviewId, agentTaskId: p.agentTaskId, kind: p.agent, tier: p.tier,
    context: AgentContext.parse(JSON.parse(raw.toString("utf8"))) });
  await deps.store.put(tenantKey(msg.tenantId, "agent-results", p.agentTaskId), Buffer.from(JSON.stringify(result)));
  return result;
}
