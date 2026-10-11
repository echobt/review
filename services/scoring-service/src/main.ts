import { runWorker } from "@review/service-common";
import { handle } from "./handler.ts";

await runWorker("scoring-service", "score.requested", () => async (msg) => { await handle(msg); });
