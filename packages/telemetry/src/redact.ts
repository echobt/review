import { createHash } from "node:crypto";

/** Keys whose values are never logged or exported: source code, prompts/completions, credentials. */
const SENSITIVE_KEY = /^(code|source|content|contents|diff|patch|prompt|prompts|messages|completion|response_text|body|text|snippet|password|passwd|secret|token|apikey|api_key|authorization|cookie|set-cookie|private_key|privatekey|dek|kek|key_material)$|(_secret|_token|_key|password)$/i;

/** Secret-looking substrings inside otherwise-loggable strings. */
const SECRET_PATTERNS: RegExp[] = [
  /\b(sk|rk|pk)[-_][A-Za-z0-9_-]{16,}\b/g,           // sk-..., rk_... api keys
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,                 // GitHub tokens
  /\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi,            // bearer headers
  /\bAKIA[0-9A-Z]{16}\b/g,                           // AWS access key id
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, // JWT
];

export const REDACTED = "[REDACTED]";
const MAX_STRING = 512;

export function redactString(s: string): string {
  let out = s;
  for (const p of SECRET_PATTERNS) out = out.replace(p, REDACTED);
  return out.length > MAX_STRING ? `${out.slice(0, MAX_STRING)}...[truncated]` : out;
}

/** Deep-redact a log/attribute payload. Sensitive keys are replaced wholesale; strings are pattern-scrubbed. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[depth]";
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  if (value instanceof Error) return { name: value.name, message: redactString(value.message) };
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = SENSITIVE_KEY.test(k) ? REDACTED : redact(v, depth + 1);
    return out;
  }
  return value;
}

/** Tenant ids are hashed before export (ADR 0007). */
export const hashTenant = (tenantId: string, salt = process.env.TELEMETRY_SALT ?? "review"): string =>
  createHash("sha256").update(`${salt}:${tenantId}`).digest("hex").slice(0, 16);
