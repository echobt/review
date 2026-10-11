import { runWorker } from "@review/service-common";
import { handle } from "./handler.ts";

await runWorker("indexer-worker", "index.requested", () => async (msg) => { await handle(msg); });
