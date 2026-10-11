import { loadConfig, connectionFromUrl, makeConsumer } from "@review/service-common";
import { handle } from "./handler.ts";

const cfg = loadConfig();
const worker = makeConsumer("sandbox.run", connectionFromUrl(cfg.REDIS_URL), async (msg) => { await handle(msg); });
console.log("sandbox-runner consuming sandbox.run");
process.on("SIGTERM", () => void worker.close());
