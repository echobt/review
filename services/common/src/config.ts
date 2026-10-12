import { readFileSync } from "node:fs";
import { z } from "zod";

export const ServiceConfig = z.object({
  DATABASE_URL: z.string().url().default("postgres://review:review@localhost:5432/review"),
  REDIS_URL: z.string().url().default("redis://localhost:6379"),
  PORT: z.coerce.number().int().positive().default(8080),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});
export type ServiceConfig = z.infer<typeof ServiceConfig>;

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): ServiceConfig => ServiceConfig.parse(env);

/** Read a secret from NAME or the file at NAME_FILE. Returns undefined if neither is set. */
export function readSecret(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const direct = env[name];
  if (direct) return direct;
  const file = env[`${name}_FILE`];
  return file ? readFileSync(file, "utf8").trim() || undefined : undefined;
}
