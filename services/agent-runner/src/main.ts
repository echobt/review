import { loadConfig, connectionFromUrl, makeConsumer } from "@review/service-common";
import { handle } from "./handler.ts";

const cfg = loadConfig();
const worker = makeConsumer("agent.task", connectionFromUrl(cfg.REDIS_URL), async (msg) => { await handle(msg); });
console.log("agent-runner consuming agent.task");
process.on("SIGTERM", () => void worker.close());
