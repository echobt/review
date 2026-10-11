import { runWorker } from "@review/service-common";
import { handle } from "./handler.ts";

await runWorker("sandbox-runner", "sandbox.run", () => async (msg) => { await handle(msg); });
