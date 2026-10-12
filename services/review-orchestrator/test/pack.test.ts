import { expect, test } from "vitest";
import { LocalCodeIndex, memoryRepoSource } from "@review/indexer-worker";
import { buildContextPack, packCovers, parseAddedImports, parseDiff, renderPack, resolveImports, touchedIdentifiers } from "../src/index.ts";

const C = "d".repeat(40);
const repo = {
  ".python-version": "3.13.1\n",
  "AGENTS.md": "Never log tokens.\n",
  "src/app/base.py": "import abc\n\nclass Handler(abc.ABC):\n    @abc.abstractmethod\n    def evaluate(self):\n        ...\n\n    @abc.abstractmethod\n    def counters(self):\n        ...\n",
  "src/app/util.py": "def fetch_state(key):\n    return STATE.get(key)\n",
  "src/app/new.py": "from app.base import Handler\nfrom app.util import fetch_state, missing_name\nimport requests\n\nclass MetricHandler(Handler):\n    def evaluate(self):\n        return fetch_state('user')\n",
  "src/app/caller.py": "from app.new import MetricHandler\n\ndef go():\n    return MetricHandler().evaluate()\n",
  "requirements.txt": "requests==2.32.0\n",
};
const DIFF = `diff --git a/src/app/new.py b/src/app/new.py
--- /dev/null
+++ b/src/app/new.py
@@ -0,0 +1,7 @@
+from app.base import Handler
+from app.util import fetch_state, missing_name
+import requests
+
+class MetricHandler(Handler):
+    def evaluate(self):
+        return fetch_state('user')
`;
const ix = new LocalCodeIndex(memoryRepoSource({ [C]: repo }), C);
const files = parseDiff(DIFF);

test("touched identifiers rank CamelCase/called names, drop keywords", () => {
  const ids = touchedIdentifiers(files);
  expect(ids.slice(0, 2)).toEqual(["Handler", "fetch_state"]); // repeated + CamelCase/called rank first
  expect(ids).toContain("fetch_state");
  expect(ids).not.toContain("return");
});

test("imports: exists / missing / external with manifest version", async () => {
  const notes = await resolveImports(ix, parseAddedImports(files));
  const s = Object.fromEntries(notes.map((n) => [`${n.module}${n.name ? "." + n.name : ""}`, `${n.status}${n.version ?? ""}`]));
  expect(s).toEqual({ "app.base.Handler": "exists", "app.util.fetch_state": "exists", "app.util.missing_name": "missing", requests: "external==2.32.0" });
});

test("pack: full files, definitions, missing abstract members, callers, versions, rules; render under budget; coverage gate", async () => {
  const pack = await buildContextPack(ix, files);
  expect(pack.files.map((f) => f.path)).toEqual(["src/app/new.py"]);
  expect(pack.definitions.map((d) => d.name)).toContain("fetch_state");
  expect(pack.classes).toEqual([expect.objectContaining({ name: "MetricHandler", implemented: ["evaluate"], missingAbstract: ["counters"] })]);
  expect(pack.callers.find((c) => c.name === "evaluate")?.callers.map((h) => h.path)).toContain("src/app/caller.py");
  expect(pack.versions.python).toBe("3.13.1");
  expect(pack.rules.map((r) => r.path)).toEqual(["AGENTS.md"]);
  const text = renderPack(pack);
  expect(text).toContain("NOT IMPLEMENTED abstract members: [counters]");
  expect(text).toContain("app.util.missing_name: MISSING");
  expect(renderPack(pack, { tokenBudget: 100 }).length).toBeLessThanOrEqual(400);
  expect(packCovers(pack, { symbol: "fetch_state" })).toBe(true);
  expect(packCovers(pack, { symbol: "Handler" })).toBe(true);
  expect(packCovers(pack, { symbol: "Nope" })).toBe(false);
});
