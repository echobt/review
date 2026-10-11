import { fileURLToPath } from "node:url";
import { pgDatabase } from "@review/db";
import { runWorker } from "@review/service-common";
import { ScoringClient } from "@review/scoring-client";
import { makeHandler } from "./handler.ts";
import { ScoringService } from "./service.ts";

const env = process.env;
await runWorker("scoring-service", "score.requested", ({ cfg }) => makeHandler(new ScoringService({
  // pg.Pool connects lazily, so memory mode boots (and serves /healthz) without Postgres.
  db: pgDatabase(cfg.DATABASE_URL),
  source: env.SCORING_REMOTE === "1"
    ? { client: new ScoringClient(env.SCORING_BASE_URL ? { baseUrl: env.SCORING_BASE_URL } : {}) }
    : { dir: env.SCORING_DIR ?? fileURLToPath(new URL("../../../docs/scoring/", import.meta.url)) },
  datasetVersion: env.SCORING_DATASET_VERSION ?? "sample-0.1",
})));
