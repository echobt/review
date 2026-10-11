import type { Message } from "@review/core";

/** Execute commands in gVisor/Firecracker sandbox, network none by default (phase 3). */
export async function handle(msg: Message<"sandbox.run">): Promise<{ status: "skeleton"; tenantId: string }> {
  // Skeleton only: real work is scheduled in docs/PLAN.md. No provider spend here.
  return { status: "skeleton", tenantId: msg.tenantId };
}
