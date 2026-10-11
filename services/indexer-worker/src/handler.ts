import type { Message } from "@review/core";

/** Parse changed files with tree-sitter, update symbol graph + embeddings incrementally (phase 1). */
export async function handle(msg: Message<"index.requested">): Promise<{ status: "skeleton"; tenantId: string }> {
  // Skeleton only: real work is scheduled in docs/PLAN.md. No provider spend here.
  return { status: "skeleton", tenantId: msg.tenantId };
}
