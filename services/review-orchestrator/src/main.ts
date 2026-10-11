import { loadConfig, connectionFromUrl, makeConsumer } from "@review/service-common";
import { handle } from "./handler.ts";

const cfg = loadConfig();
const worker = makeConsumer("review.requested", connectionFromUrl(cfg.REDIS_URL), async (msg) => { await handle(msg); });
console.log("review-orchestrator consuming review.requested");
process.on("SIGTERM", () => void worker.close());
