import { matchesGlob } from "node:path";
import type { Finding, FindingCategory, Severity } from "@review/core";

/** GREPTILE-GAP §7.2: one feedback event on a posted finding. */
export interface FeedbackEvent { category: FindingCategory; severity: Severity; path: string; verdict: "dismissed" | "thumbs_down" | "resolved" | "thumbs_up" }

export interface LearnedRule { id: string; category: FindingCategory; pathGlob: string; dismissals: number; total: number; rate: number }

export const MIN_DISMISSALS = 5;
export const MIN_RATE = 0.8;
const PROTECTED: Severity[] = ["high", "critical"];

/** Path glob of the cluster: the finding's directory (two levels max) plus extension, e.g. `src/sentry/**\/*.py`. */
export function clusterGlob(path: string): string {
  const parts = path.split("/");
  const dir = parts.slice(0, Math.min(2, parts.length - 1)).join("/");
  const ext = path.includes(".") ? path.slice(path.lastIndexOf(".")) : "";
  return `${dir ? dir + "/" : ""}**/*${ext}`;
}

/**
 * Cluster feedback per (category, path glob). A cluster with >= 5 dismissals and >= 80% dismissal rate becomes a learned
 * suppression rule. Guardrail: security findings and severity >= high never count toward (or get) suppression.
 */
export function learnSuppressionRules(events: FeedbackEvent[], opts: { minDismissals?: number; minRate?: number } = {}): LearnedRule[] {
  const minD = opts.minDismissals ?? MIN_DISMISSALS, minR = opts.minRate ?? MIN_RATE;
  const clusters = new Map<string, { category: FindingCategory; pathGlob: string; d: number; n: number }>();
  for (const e of events) {
    if (e.category === "security" || PROTECTED.includes(e.severity)) continue;
    const pathGlob = clusterGlob(e.path);
    const k = `${e.category}\0${pathGlob}`;
    const c = clusters.get(k) ?? { category: e.category, pathGlob, d: 0, n: 0 };
    c.n++;
    if (e.verdict === "dismissed" || e.verdict === "thumbs_down") c.d++;
    clusters.set(k, c);
  }
  return [...clusters.values()].filter((c) => c.d >= minD && c.d / c.n >= minR)
    .map((c) => ({ id: `learned:${c.category}:${c.pathGlob}`, category: c.category, pathGlob: c.pathGlob, dismissals: c.d, total: c.n, rate: c.d / c.n }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Apply learned rules; the guardrail is enforced again here so a stale rule can never hide high/critical or security findings. */
export function applyLearnedRules<T extends Pick<Finding, "category" | "severity" | "location">>(findings: T[], rules: LearnedRule[]): { kept: T[]; suppressed: T[] } {
  const kept: T[] = [], suppressed: T[] = [];
  for (const f of findings) {
    const protectedF = f.category === "security" || PROTECTED.includes(f.severity);
    const hit = !protectedF && rules.some((r) => r.category === f.category && matchesGlob(f.location.path, r.pathGlob));
    (hit ? suppressed : kept).push(f);
  }
  return { kept, suppressed };
}
