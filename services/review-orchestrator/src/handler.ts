import type { Message } from "@review/core";

/** Plan the review: fetch diff, retrieve context, fan out agent.task jobs, merge + verify findings (phase 2). */
export async function handle(msg: Message<"review.requested">): Promise<{ status: "skeleton"; tenantId: string }> {
  // Skeleton only: real work is scheduled in docs/PLAN.md. No provider spend here.
  return { status: "skeleton", tenantId: msg.tenantId };
}
