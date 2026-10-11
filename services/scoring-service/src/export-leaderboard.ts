import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Submission, buildLeaderboard, scoreSubmission, type Leaderboard } from "@review/scoring-client";
import { loadPinned } from "./service.ts";

/** node src/export-leaderboard.ts --dir docs/scoring --dataset sample-0.1 [--rubric 1.0.0] [--out leaderboard.json] */
export async function exportLeaderboard(argv: string[]): Promise<Leaderboard> {
  const { values: v } = parseArgs({ args: argv, options: {
    dir: { type: "string" }, dataset: { type: "string", default: "sample-0.1" }, rubric: { type: "string", default: "1.0.0" },
    out: { type: "string" }, "generated-at": { type: "string" },
  } });
  if (!v.dir) throw new Error("usage: export-leaderboard.ts --dir <scoring repo> [--out file]");
  const { rubric, dataset } = await loadPinned({ dir: v.dir }, v.rubric, v.dataset);
  const subDir = join(v.dir, "submissions");
  const entries = readdirSync(subDir).map((d) => join("submissions", d, "submission.json"))
    .filter((p) => existsSync(join(v.dir!, p)))
    .map((path) => ({ path, submission: Submission.parse(JSON.parse(readFileSync(join(v.dir!, path), "utf8"))) }))
    .filter((e) => e.submission.rubricVersion === rubric.version && e.submission.datasetVersion === dataset.version)
    // ponytail: rescored by the reference scorer but `verified` stays false until maintainers reproduce the harness run.
    .map((e) => ({ ...e, result: scoreSubmission(dataset, e.submission, rubric), verified: false }));
  const lb = buildLeaderboard(entries, v["generated-at"]);
  const lbOut = entries.length ? lb : { ...lb, rubricVersion: rubric.version, datasetVersion: dataset.version };
  if (v.out) writeFileSync(v.out, `${JSON.stringify(lbOut, null, 2)}\n`);
  return lbOut;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const lb = await exportLeaderboard(process.argv.slice(2));
  console.log(`leaderboard: ${lb.entries.length} entries`);
}
