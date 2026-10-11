import { runWorker } from "@review/service-common";
import { handle } from "./handler.ts";

await runWorker("review-orchestrator", "review.requested", () => async (msg) => { await handle(msg); });
