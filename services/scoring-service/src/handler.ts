import type { Message } from "@review/core";

/** Score a review against a labelled dataset case using the public rubric (phase 4). */
export async function handle(msg: Message<"score.requested">): Promise<{ status: "skeleton"; tenantId: string }> {
  // Skeleton only: real work is scheduled in docs/PLAN.md. No provider spend here.
  return { status: "skeleton", tenantId: msg.tenantId };
}
