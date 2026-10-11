import { pgDatabase } from "@review/db";
import { memoryObjectStore, runWorker, s3ObjectStore } from "@review/service-common";
import { handle } from "./handler.ts";
import { selectDriver } from "./sandbox.ts";

await runWorker("sandbox-runner", "sandbox.run", ({ cfg }) => {
  const memory = cfg.RUNTIME_MODE === "memory";
  const driver = selectDriver(process.env);
  const store = memory ? memoryObjectStore() : s3ObjectStore({ bucket: cfg.S3_BUCKET, region: cfg.S3_REGION, ...(cfg.S3_ENDPOINT ? { endpoint: cfg.S3_ENDPOINT } : {}) });
  const db = memory ? undefined : pgDatabase(cfg.DATABASE_URL);
  return async (msg) => { await handle(msg, { driver, store, ...(db ? { db } : {}) }); };
});
