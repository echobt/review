import { runWorker } from "@review/service-common";
import { handle } from "./handler.ts";

await runWorker("agent-runner", "agent.task", () => async (msg) => { await handle(msg); });
