import { loadConfig, connectionFromUrl, makeConsumer } from "@review/service-common";
import { handle } from "./handler.ts";

const cfg = loadConfig();
const worker = makeConsumer("score.requested", connectionFromUrl(cfg.REDIS_URL), async (msg) => { await handle(msg); });
console.log("scoring-service consuming score.requested");
process.on("SIGTERM", () => void worker.close());
