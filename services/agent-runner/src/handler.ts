import type { Message } from "@review/core";

/** Run one agent (bug-hunter, security, cross-file, verifier...) via ModelRouter within its budget (phase 2). */
export async function handle(msg: Message<"agent.task">): Promise<{ status: "skeleton"; tenantId: string }> {
  // Skeleton only: real work is scheduled in docs/PLAN.md. No provider spend here.
  return { status: "skeleton", tenantId: msg.tenantId };
}
