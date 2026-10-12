import { loadConfig, connectionFromUrl, makeConsumer } from "@review/service-common";
import { handle } from "./handler.ts";

const cfg = loadConfig();
const worker = makeConsumer("index.requested", connectionFromUrl(cfg.REDIS_URL), async (msg) => { await handle(msg); });
console.log("indexer-worker consuming index.requested");
process.on("SIGTERM", () => void worker.close());
