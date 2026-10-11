import { matchesGlob } from "node:path";
import type { AgentKind, TenantConfig } from "@review/core";

export interface Hunk { newStart: number; newLines: number; text: string }
export interface DiffFile { path: string; hunks: Hunk[] }

/** Parse a unified (git) diff. Deleted files are dropped: there is no new side to comment on. */
export function parseDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  let cur: DiffFile | undefined;
  let hunk: Hunk | undefined;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) { cur = undefined; hunk = undefined; continue; }
    if (line.startsWith("+++ ")) {
      const p = line.slice(4).trim();
      hunk = undefined;
      cur = p === "/dev/null" ? undefined : { path: p.replace(/^b\//, ""), hunks: [] };
      if (cur) files.push(cur);
      continue;
    }
    if (line.startsWith("--- ")) { hunk = undefined; continue; }
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (h && cur) { hunk = { newStart: Number(h[1]), newLines: Number(h[2] ?? 1), text: line }; cur.hunks.push(hunk); continue; }
    if (hunk && /^[ +\-\\]/.test(line)) hunk.text += "\n" + line;
  }
  return files;
}

export const pathAllowed = (path: string, f: TenantConfig["pathFilters"]) =>
  f.include.some((g) => matchesGlob(path, g)) && !f.exclude.some((g) => matchesGlob(path, g));

export const filterFiles = (files: DiffFile[], f: TenantConfig["pathFilters"]) => files.filter((x) => pathAllowed(x.path, f));

const CODE = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|rb|php|cs|c|cc|cpp|h|hpp|swift|scala|sh|sql)$/i;
export const isCode = (path: string) => CODE.test(path);

export interface ReviewUnit { kind: AgentKind; files: { path: string; patch: string }[]; rules: { name: string; body: string }[] }

/** Natural-language rules whose path globs match any of the files. */
export function rulesFor(paths: string[], config: TenantConfig) {
  return config.rules
    .filter((r) => r.enabled && r.kind === "natural-language" && r.paths.some((g) => paths.some((p) => matchesGlob(p, g))))
    .map((r) => ({ name: r.name, body: r.body }));
}

/**
 * Review units: one per file (patch capped at maxChars, extra hunks split into further units) for bug-hunter,
 * plus security for code files; one cross-file unit over all files when the change spans >1 file.
 */
export function planReview(files: DiffFile[], config: TenantConfig, maxChars = 24_000): ReviewUnit[] {
  const units: ReviewUnit[] = [];
  for (const f of files) {
    const chunks: string[] = [];
    for (const h of f.hunks) {
      // ponytail: a single hunk larger than maxChars is truncated; split by lines when giant hunks matter.
      const t = h.text.slice(0, maxChars);
      if (chunks.length && chunks.at(-1)!.length + t.length + 1 <= maxChars) chunks[chunks.length - 1] += "\n" + t;
      else chunks.push(t);
    }
    const rules = rulesFor([f.path], config);
    for (const patch of chunks) {
      units.push({ kind: "bug-hunter", files: [{ path: f.path, patch }], rules });
      if (isCode(f.path)) units.push({ kind: "security", files: [{ path: f.path, patch }], rules });
    }
  }
  if (files.length > 1) {
    let budget = maxChars;
    const all = files.map((f) => { const patch = f.hunks.map((h) => h.text).join("\n").slice(0, Math.max(0, budget)); budget -= patch.length; return { path: f.path, patch }; }).filter((f) => f.patch);
    units.push({ kind: "cross-file", files: all, rules: rulesFor(files.map((f) => f.path), config) });
  }
  return units;
}
