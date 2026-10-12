import { expect, test } from "vitest";
import { StandingIndex, memoryRepoSource } from "../src/index.ts";

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
