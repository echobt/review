import type { TenantConfig } from "@review/core";
import type { DiffFile } from "./plan.ts";
import { addedLines } from "./pack.ts";

export type Depth = Exclude<TenantConfig["reviewDepth"], "auto">;

/** Concurrent agent calls per review, capped by tier (LATENCY-PLAN §3.2.3). */
export const TIER_WIDTH: Record<Depth, number> = { fast: 8, standard: 16, deep: 24 };

const SECURITY_PATH = /(^|\/)(auth|authn|authz|oauth|saml|sso|crypto|security|permissions?|acl|rbac|session|token|password|secrets?|sandbox)(\/|[._-])/i;

export interface TierSignals { addedLines: number; codeFiles: number; securityPaths: string[]; deterministicFailures: number }

export function tierSignals(files: DiffFile[], deterministicFailures = 0): TierSignals {
  return {
    addedLines: files.reduce((n, f) => n + addedLines(f).length, 0),
    codeFiles: files.length,
    securityPaths: files.map((f) => f.path).filter((p) => SECURITY_PATH.test(p)),
    deterministicFailures,
  };
}

/**
 * Auto depth (Greptile "Auto", LATENCY-PLAN §5.2.4): small low-risk PRs get `fast`, security-sensitive or very large PRs
 * get `deep`, everything else `standard`. An explicit tenant depth always wins.
 * ponytail: thresholds from the plan, not yet calibrated on the 50-case set; tune once per-case recall by depth exists.
 */
export function selectDepth(configured: TenantConfig["reviewDepth"], s: TierSignals): { depth: Depth; reason: string } {
  if (configured !== "auto") return { depth: configured, reason: "configured" };
  if (s.securityPaths.length) return { depth: "deep", reason: `security-sensitive paths: ${s.securityPaths.slice(0, 3).join(", ")}` };
  if (s.addedLines > 2000) return { depth: "deep", reason: `${s.addedLines} added lines > 2000` };
  if (s.addedLines <= 200 && s.codeFiles <= 5 && s.deterministicFailures === 0) return { depth: "fast", reason: `${s.addedLines} added lines in ${s.codeFiles} files` };
  return { depth: "standard", reason: `${s.addedLines} added lines in ${s.codeFiles} files` };
}
