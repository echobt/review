import { expect, test } from "vitest";
import { BlobCache, LocalCodeIndex, StandingIndex, gitRepoSource, memoryRepoSource, type GrepOptions } from "../src/index.ts";
import { availableParallelism } from "node:os";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { promisify } from "node:util";

const C1 = "1".repeat(40), C2 = "2".repeat(40), C3 = "3".repeat(40);
const a = "def helper(x):\n    return x + 1\n";
const b1 = "from a import helper\n\ndef run():\n    return helper(1)\n";
const b2 = "from a import helper\n\ndef run():\n    return helper(2)\n";
const source = memoryRepoSource({ [C1]: { "a.py": a, "b.py": b1 }, [C2]: { "a.py": a, "b.py": b2 }, [C3]: { "a.py": a, "b.py": b2, "c.py": "def c():\n    pass\n" } });

test("a second review of the same repo@sha reuses the index; a new head reuses unchanged blobs (no per-PR rebuild)", async () => {
  const s = new StandingIndex(() => source);
  const ix = await s.ensureIndexed("repo", C1);
  expect((await ix.definitions("helper"))[0]).toMatchObject({ path: "a.py", startLine: 1 });
  expect(await s.ensureIndexed("repo", C1)).toBe(ix);
  expect(s.builds).toBe(1);
  expect(s.lookup("repo", C1)?.index).toBe(ix);

  source.reads.length = 0;
  const ix2 = await s.ensureIndexed("repo", C2);
  await ix2.parse("a.py");
  await ix2.parse("b.py");
  expect(source.reads).toHaveLength(1);
  expect(s.stats("repo")!.cache.parseHits).toBeGreaterThan(0);
});

test("update (push) moves the branch head, reports changed vs reused, warms only changed files off the critical path", async () => {
  const s = new StandingIndex(() => source);
  const first = await s.update("repo", "main", C2);
  expect([first.files, first.changed, first.reused]).toEqual([2, 2, 0]);
  expect(await first.warmed).toBe(2);
  const next = await s.update("repo", "main", C3);
  expect([next.files, next.changed, next.reused]).toEqual([3, 1, 2]);
  expect(await next.warmed).toBe(1);
  expect(s.head("repo", "main")?.commitSha).toBe(C3);
  expect(s.lookup("repo", C2)).toBeDefined();
});

test("invalidate drops a branch head or the whole repository; LRU keeps the branch head", async () => {
  const s = new StandingIndex(() => source, { maxCommitsPerRepo: 1 });
  await s.update("repo", "main", C1);
  await s.ensureIndexed("repo", C2);
  await s.ensureIndexed("repo", C3);
  expect(s.lookup("repo", C1)).toBeDefined();
  expect(s.lookup("repo", C2)).toBeUndefined();
  s.invalidate("repo", "main");
  expect(s.head("repo", "main")).toBeUndefined();
  s.invalidate("repo");
  expect(s.stats("repo")).toBeUndefined();
});

test("blob cache is bounded by bytes, evicting least recently used entries", async () => {
  const c = new BlobCache(1000);
  const load = (n: number) => async () => "x".repeat(n);
  await c.text("a", load(200));
  await c.text("b", load(200));
  await c.text("a", load(200));
  await c.text("c", load(200));
  expect(c.size.bytes).toBeLessThanOrEqual(1000);
  expect(c.stats.evictions).toBe(1);
  let reloaded = false;
  await c.text("b", async () => { reloaded = true; return "y"; });
  expect(reloaded).toBe(true);
  await c.parsed("p.py", "s1", async () => ({ parsed: { language: "python", entities: [], edges: [], imports: [] }, sourceChars: 50 }));
  expect(c.size.bytes).toBeLessThanOrEqual(1000);
  expect(c.has("p.py", "s1")).toBe(true);
});

test("git grep is streamed and truncated at maxHits instead of failing on huge output", async () => {
  const dir = await mkdtemp(`${tmpdir()}/grep-`);
  const git = promisify(execFile);
  await git("git", ["init", "-q", dir]);
  await writeFile(`${dir}/big.py`, Array.from({ length: 50_000 }, (_, i) => `value_${i} = common_name`).join("\n"));
  await git("git", ["-C", dir, "add", "."]);
  await git("git", ["-C", dir, "-c", "user.email=a@b", "-c", "user.name=a", "commit", "-qm", "1"]);
  const sha = (await git("git", ["-C", dir, "rev-parse", "HEAD"])).stdout.trim();
  const hits = await gitRepoSource(dir).grep!(sha, "common_name", { maxHits: 100 });
  expect(hits).toHaveLength(100);
  expect(hits[0]).toMatchObject({ path: "big.py", line: 1 });
  expect(await gitRepoSource(dir).grep!(sha, "no_such_token_here")).toEqual([]);
});

test("whole-repo grep is memoized per commit and bounded in concurrency", async () => {
  let calls = 0, active = 0, peak = 0;
  const base = memoryRepoSource({ c1: { "a.py": "def get_cursor():\n  pass\n" } });
  const src = { ...base, grep: async (_sha: string, p: string, _o?: GrepOptions) => {
    calls++; active++; peak = Math.max(peak, active);
    await new Promise<void>((r) => setImmediate(r));
    active--;
    return "def get_cursor():\n  pass".split("\n").flatMap((text, i) => (new RegExp(p).test(text) ? [{ path: "a.py", line: i + 1, text }] : []));
  } };
  const ix = new LocalCodeIndex(src, "c1");
  const runs = await Promise.all(Array.from({ length: 40 }, (_, i) => ix.grep(i % 2 ? "get_cursor" : "pass")));
  expect(calls).toBe(2);
  expect(runs[1]).toEqual([{ path: "a.py", line: 1, text: "def get_cursor():" }]);
  await Promise.all(Array.from({ length: 40 }, (_, i) => ix.grep(`p${i}`)));
  expect(peak).toBeLessThanOrEqual(Math.max(2, availableParallelism()));
});
