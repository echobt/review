import { createHash } from "node:crypto";
import { SEVERITY_WEIGHT, type Finding, type Location, type TenantConfig } from "@review/core";

export const normalizeTitle = (t: string) => t.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Stable across re-runs: path + 5-line bucket of startLine + category + normalized title. */
export function fingerprint(f: Pick<Finding, "location" | "category" | "title">): string {
  return createHash("sha256").update(JSON.stringify([f.location.path, Math.floor(f.location.startLine / 5), f.category, normalizeTitle(f.title)])).digest("hex");
}

export const rankScore = (f: Finding) => SEVERITY_WEIGHT[f.severity] * f.confidence;
const locKey = (l: Location) => `${l.path}:${l.startLine}-${l.endLine}`;

export interface MergedFinding { finding: Finding; fingerprint: string }

/**
 * Dedup by fingerprint (keep highest confidence, merge other locations into `related`), drop suppressed and
 * below-threshold findings, rank by severity weight x confidence (deterministic tie-break), cap to maxComments.
 */
export function mergeFindings(findings: Finding[], opts: { config: Pick<TenantConfig, "confidenceThreshold" | "maxComments">; suppressed?: Set<string> }): MergedFinding[] {
  const groups = new Map<string, Finding[]>();
  for (const f of findings) {
    const fp = fingerprint(f);
    groups.set(fp, [...(groups.get(fp) ?? []), f]);
  }
  const merged: MergedFinding[] = [];
  for (const [fp, group] of groups) {
    if (opts.suppressed?.has(fp)) continue;
    const best = [...group].sort((a, b) => b.confidence - a.confidence || a.id.localeCompare(b.id))[0]!;
    const seen = new Set([locKey(best.location)]);
    const related: Location[] = [];
    for (const l of group.flatMap((f) => [f.location, ...f.related])) if (!seen.has(locKey(l))) { seen.add(locKey(l)); related.push(l); }
    merged.push({ finding: { ...best, related }, fingerprint: fp });
  }
  return merged
    .filter((m) => m.finding.confidence >= opts.config.confidenceThreshold)
    .sort((a, b) => rankScore(b.finding) - rankScore(a.finding)
      || SEVERITY_WEIGHT[b.finding.severity] - SEVERITY_WEIGHT[a.finding.severity]
      || a.finding.location.path.localeCompare(b.finding.location.path)
      || a.finding.location.startLine - b.finding.location.startLine
      || a.fingerprint.localeCompare(b.fingerprint))
    .slice(0, opts.config.maxComments);
}
