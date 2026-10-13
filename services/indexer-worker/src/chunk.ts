import { createHash } from "node:crypto";
import type { Entity, ParsedFile } from "./parse.ts";

export interface Chunk { path: string; startLine: number; endLine: number; text: string; embedText: string; contentHash: string; symbolFq?: string }

export const MAX_CHUNK_TOKENS = 1500;
const tokens = (s: string) => Math.ceil(s.length / 4);
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/**
 * AST-aligned chunks: one per top-level entity; a class over MAX_CHUNK_TOKENS is split into its methods plus
 * the class remainder; module-level leftovers are grouped between entities. content_hash covers the
 * embedding text (header + code) so a header change re-embeds.
 */
export function chunkFile(path: string, source: string, parsed: ParsedFile | undefined): Chunk[] {
  const lines = source.split("\n");
  const header = `// file: ${path}${parsed?.imports.length ? ` | imports: ${[...new Set(parsed.imports)].slice(0, 20).join(", ")}` : ""}`;
  const out: Chunk[] = [];
  const emit = (startLine: number, endLine: number, symbolFq?: string) => {
    const text = lines.slice(startLine - 1, endLine).join("\n");
    if (!text.trim()) return;
    const embedText = `${header}\n${text}`;
    out.push({ path, startLine, endLine, text, embedText, contentHash: sha256(embedText), ...(symbolFq ? { symbolFq } : {}) });
  };

  const ents = parsed?.entities ?? [];
  const top = ents.filter((e) => !ents.some((o) => o !== e && o.startIndex <= e.startIndex && o.endIndex >= e.endIndex && (o.endIndex - o.startIndex) > (e.endIndex - e.startIndex)));
  top.sort((a, b) => a.startLine - b.startLine);

  let cursor = 1;
  const gap = (until: number) => { if (until > cursor) emit(cursor, until - 1); };
  for (const e of top) {
    if (e.startLine < cursor) continue; // same-line overlap (e.g. two decls on one line) already covered
    gap(e.startLine);
    const body = lines.slice(e.startLine - 1, e.endLine).join("\n");
    const members = ents.filter((m) => m !== e && m.startIndex >= e.startIndex && m.endIndex <= e.endIndex && m.kind === "method")
      .sort((a, b) => a.startLine - b.startLine);
    if (tokens(body) > MAX_CHUNK_TOKENS && members.length) splitClass(e, members, emit);
    else emit(e.startLine, e.endLine, e.fqName);
    cursor = e.endLine + 1;
  }
  gap(lines.length + 1);
  return out;
}

function splitClass(cls: Entity, methods: Entity[], emit: (s: number, e: number, fq?: string) => void) {
  let c = cls.startLine;
  for (const m of methods) {
    if (m.startLine < c) continue;
    if (m.startLine > c) emit(c, m.startLine - 1, cls.fqName);
    emit(m.startLine, m.endLine, m.fqName);
    c = m.endLine + 1;
  }
  if (c <= cls.endLine) emit(c, cls.endLine, cls.fqName);
}
