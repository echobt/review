import type { Sql } from "@review/db";

export interface Ranked { id: string; score: number }

/** Reciprocal Rank Fusion: score(d) = sum over lists of 1/(k + rank), rank 1-based. Ties broken by id ascending. */
export function rrf(lists: string[][], k = 60): Ranked[] {
  const s = new Map<string, number>();
  for (const l of lists) l.forEach((id, i) => s.set(id, (s.get(id) ?? 0) + 1 / (k + i + 1)));
  return [...s].map(([id, score]) => ({ id, score })).sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export interface RetrieveOptions { indexId: string; query: string; queryVector?: number[]; seedSymbols?: string[]; k?: number }
export interface RetrievedChunk { id: string; path: string; startLine: number; endLine: number; contentCiphertext: Buffer; score: number; via: ("vector" | "lexical" | "graph")[] }

const POOL = 50;
const words = (q: string) => [...new Set(q.toLowerCase().match(/[a-z_][a-z0-9_]*/g) ?? [])];

/** Hybrid retrieval over one index (caller sets the tenant via withTenant). */
export async function retrieve(sql: Sql, o: RetrieveOptions): Promise<RetrievedChunk[]> {
  const ids = <T extends { id: string }>(r: { rows: T[] }) => r.rows.map((x) => x.id);
  const vector = o.queryVector
    ? ids(await sql.query<{ id: string }>(`SELECT id FROM chunks WHERE index_id = $1 AND embedding IS NOT NULL ORDER BY embedding <=> $2::vector, id LIMIT ${POOL}`, [o.indexId, `[${o.queryVector.join(",")}]`]))
    : [];
  // plainto_tsquery (all terms) matches rank first; OR-of-terms keeps partial matches. ponytail: add field weights/phrase proximity later.
  const terms = words(o.query);
  const lexical = terms.length
    ? ids(await sql.query<{ id: string }>(`SELECT id FROM chunks, to_tsquery('simple', $2) q WHERE index_id = $1 AND tsv @@ q ORDER BY tsv @@ plainto_tsquery('simple', $3) DESC, ts_rank_cd(tsv, q) DESC, id LIMIT ${POOL}`, [o.indexId, terms.join(" | "), o.query]))
    : [];
  const graph = await graphNeighborhood(sql, o.indexId, [...(o.seedSymbols ?? []), ...terms]);
  const fused = rrf([vector, lexical, graph]).slice(0, o.k ?? 10);
  if (!fused.length) return [];
  const rows = (await sql.query<{ id: string; path: string; start_line: number; end_line: number; content_ciphertext: Uint8Array }>(
    "SELECT id, path, start_line, end_line, content_ciphertext FROM chunks WHERE id = ANY($1)", [fused.map((f) => f.id)])).rows;
  const byId = new Map(rows.map((r) => [r.id, r]));
  return fused.flatMap((f) => {
    const r = byId.get(f.id);
    if (!r) return [];
    const via = ([["vector", vector], ["lexical", lexical], ["graph", graph]] as const).filter(([, l]) => l.includes(f.id)).map(([n]) => n);
    return [{ id: r.id, path: r.path, startLine: r.start_line, endLine: r.end_line, contentCiphertext: Buffer.from(r.content_ciphertext), score: f.score, via }];
  });
}

/** Chunks of seed symbols and their callers/callees up to depth 2, ordered by depth. Seeds not in the index are ignored. */
async function graphNeighborhood(sql: Sql, indexId: string, seeds: string[]): Promise<string[]> {
  let frontier = (await sql.query<{ name: string }>("SELECT DISTINCT name FROM symbols WHERE index_id = $1 AND name = ANY($2)", [indexId, seeds])).rows.map((r) => r.name);
  const depth = new Map(frontier.map((n) => [n, 0]));
  for (let d = 1; d <= 2 && frontier.length; d++) {
    const r = await sql.query<{ name: string }>(
      `SELECT e.dst_name AS name FROM symbol_edges e JOIN symbols s ON s.id = e.src_symbol_id WHERE e.index_id = $1 AND e.kind = 'call' AND s.name = ANY($2)
       UNION SELECT s.name FROM symbol_edges e JOIN symbols s ON s.id = e.src_symbol_id WHERE e.index_id = $1 AND e.kind = 'call' AND e.dst_name = ANY($2)`,
      [indexId, frontier]);
    frontier = r.rows.map((x) => x.name).filter((n) => !depth.has(n)).sort();
    for (const n of frontier) depth.set(n, d);
  }
  if (!depth.size) return [];
  const rows = (await sql.query<{ id: string; name: string }>(
    `SELECT DISTINCT c.id, s.name FROM chunks c JOIN symbols s ON s.index_id = c.index_id AND s.path = c.path AND s.start_line >= c.start_line AND s.end_line <= c.end_line
     WHERE c.index_id = $1 AND s.name = ANY($2)`, [indexId, [...depth.keys()]])).rows;
  const best = new Map<string, number>();
  for (const r of rows) best.set(r.id, Math.min(best.get(r.id) ?? 9, depth.get(r.name)!));
  return [...best].sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1)).map(([id]) => id);
}
