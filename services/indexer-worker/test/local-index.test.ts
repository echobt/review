import { expect, test } from "vitest";
import { LocalCodeIndex, bm25, declPattern, memoryRepoSource, parseSource } from "../src/index.ts";

const C = "c".repeat(40);
const files = {
  "src/proc/detector.py": [
    "import abc",
    "class StatefulDetectorHandler(abc.ABC):",
    "    @abc.abstractmethod",
    "    def counter_names(self):",
    "        pass",
    "",
    "    def evaluate(self):",
    "        raise NotImplementedError",
    "",
    "    def run(self):",
    "        return self.evaluate()",
    "",
  ].join("\n"),
  "src/handlers/metric.py": "from src.proc.detector import StatefulDetectorHandler\n\nclass MetricHandler(StatefulDetectorHandler[int]):\n    pass\n\nh = MetricHandler()\n",
  "tests/test_metric.py": "from src.handlers.metric import MetricHandler\n\ndef test_it():\n    return MetricHandler()\n",
  "lib/greeter.rb": "class Greeter < Base\n  def hello(name)\n    puts name\n  end\nend\n",
  "src/Svc.java": "abstract class Svc extends Base implements Runnable, Closeable {\n  abstract void go();\n}\n",
};
const ix = new LocalCodeIndex(memoryRepoSource({ [C]: files }), C);

test("parse: python bases + abstract markers, ruby classes/methods, java abstract + interfaces", async () => {
  const py = (await parseSource("a.py", files["src/proc/detector.py"]))!;
  const by = (n: string) => py.entities.find((e) => e.name === n)!;
  expect(by("StatefulDetectorHandler").bases).toEqual(["ABC"]);
  expect([by("counter_names").abstract, by("evaluate").abstract, by("run").abstract]).toEqual([true, true, undefined]);
  expect((await parseSource("m.py", files["src/handlers/metric.py"]))!.entities[0]).toMatchObject({ name: "MetricHandler", bases: ["StatefulDetectorHandler"] });
  const rb = (await parseSource("lib/greeter.rb", files["lib/greeter.rb"]))!;
  expect(rb.entities.map((e) => [e.name, e.kind])).toEqual([["Greeter", "class"], ["hello", "method"]]);
  expect(rb.entities[0]!.bases).toEqual(["Base"]);
  const java = (await parseSource("src/Svc.java", files["src/Svc.java"]))!;
  expect(java.entities[0]).toMatchObject({ name: "Svc", abstract: true, bases: ["Base", "Runnable", "Closeable"] });
  expect(java.entities.find((e) => e.name === "go")?.abstract).toBe(true);
});

test("definitions, members, references (no declarations/imports), grep fallback", async () => {
  const [d] = await ix.definitions("StatefulDetectorHandler");
  expect(d).toMatchObject({ path: "src/proc/detector.py", startLine: 2, kind: "class" });
  expect((await ix.members(d!)).filter((m) => m.abstract).map((m) => m.name)).toEqual(["counter_names", "evaluate"]);
  const refs = await ix.references("MetricHandler");
  expect(refs.map((r) => `${r.path}:${r.line}`)).toEqual(["src/handlers/metric.py:6", "tests/test_metric.py:4"]);
  expect((await ix.definitions("nope_missing"))).toEqual([]);
  expect(new RegExp(declPattern(["go"]).replace(/\[\[:space:\]\]/g, "\\s")).test("func (s *S) go() {")).toBe(true);
});

test("hybrid search fuses lexical, vector and graph; bm25 prefers the matching doc", async () => {
  const hits = await ix.search("StatefulDetectorHandler evaluate", { seeds: ["StatefulDetectorHandler"] });
  expect(hits[0]!.path).toBe("src/proc/detector.py");
  expect(hits[0]!.via).toContain("graph");
  const s = bm25(["alpha beta", "gamma delta", "beta beta"], ["beta"]);
  expect(s[1]).toBe(0);
  expect(s[2]).toBeGreaterThan(s[0]!);
});
