import { readFileSync } from "node:fs";
import { z } from "zod";

export const ServiceConfig = z.object({
  DATABASE_URL: z.string().url().default("postgres://review_app:review_app@localhost:5432/review"),
  MIGRATION_DATABASE_URL: z.string().url().optional(),
  REDIS_URL: z.string().url().default("redis://localhost:6379"),
  PORT: z.coerce.number().int().positive().default(8080),
  HEALTH_PORT: z.coerce.number().int().positive().optional(),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
  S3_ENDPOINT: z.string().url().optional(),
  S3_BUCKET: z.string().default("review"),
  S3_REGION: z.string().default("us-east-1"),
  /** "memory" runs without Postgres/Valkey/MinIO (dev smoke, tests). */
  RUNTIME_MODE: z.enum(["full", "memory"]).default("full"),
});
export type ServiceConfig = z.infer<typeof ServiceConfig>;

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): ServiceConfig => ServiceConfig.parse(env);

/** Read a secret from NAME or the file at NAME_FILE. Returns undefined if neither is set. Never logs the value. */
export function readSecret(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const direct = env[name];
  if (direct) return direct;
  const file = env[`${name}_FILE`];
  return file ? readFileSync(file, "utf8").trim() || undefined : undefined;
}
