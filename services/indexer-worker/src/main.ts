import { runWorker } from "@review/service-common";
import { createIndexerDeps, makeHandler } from "./handler.ts";

await runWorker("indexer-worker", "index.requested", ({ cfg, log }) => {
  const deps = createIndexerDeps(cfg);
  if (!deps) {
    log.warn("RUNTIME_MODE=memory: no database, index jobs are skipped");
    return async (msg) => { log.warn("index job skipped", { messageId: msg.messageId, tenantId: msg.tenantId }); };
  }
  const run = makeHandler(deps);
  return async (msg) => { await run(msg); };
});
