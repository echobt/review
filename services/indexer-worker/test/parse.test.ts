import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { chunkFile } from "../src/chunk.ts";
import { detectLanguage, parseSource } from "../src/parse.ts";

const fx = (n: string) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), "utf8");
const pick = (es: { name: string; kind: string; fqName: string; startLine: number; endLine: number }[]) => es.map(({ name, kind, fqName, startLine, endLine }) => ({ name, kind, fqName, startLine, endLine }));

test("detectLanguage by extension", () => {
  expect(["a.ts", "a.tsx", "a.mjs", "a.py", "a.go", "A.java", "a.rs", "a.md"].map(detectLanguage))
    .toEqual(["typescript", "tsx", "javascript", "python", "go", "java", "rust", undefined]);
});

test("typescript entities and edges", async () => {
  const p = (await parseSource("src/sample.ts", fx("sample.ts")))!;
  expect(pick(p.entities)).toEqual([
    { name: "Greeter", kind: "class", fqName: "src/sample.ts#Greeter", startLine: 6, endLine: 14 },
    { name: "greet", kind: "method", fqName: "src/sample.ts#Greeter.greet", startLine: 7, endLine: 9 },
    { name: "shout", kind: "method", fqName: "src/sample.ts#Greeter.shout", startLine: 11, endLine: 13 },
    { name: "format", kind: "function", fqName: "src/sample.ts#format", startLine: 16, endLine: 18 },
    { name: "run", kind: "function", fqName: "src/sample.ts#run", startLine: 20, endLine: 23 },
    { name: "Options", kind: "interface", fqName: "src/sample.ts#Options", startLine: 25, endLine: 25 },
    { name: "Id", kind: "type", fqName: "src/sample.ts#Id", startLine: 26, endLine: 26 },
  ]);
  const calls = p.edges.filter((e) => e.kind === "call").map((e) => [e.src, e.dstName, e.line]);
  expect(calls).toEqual(expect.arrayContaining([
    ["src/sample.ts#Greeter.greet", "format", 8],
    ["src/sample.ts#Greeter.shout", "greet", 12],
    ["src/sample.ts#Greeter.shout", "toUpperCase", 12],
    ["src/sample.ts#format", "slice", 17],
    ["src/sample.ts#run", "readFile", 21],
    ["src/sample.ts#run", "Greeter", 22],
  ]));
  expect(p.edges.filter((e) => e.kind === "import").map((e) => e.dstName)).toEqual(["node:fs/promises", "readFile", "./util", "helper", "a", "b"]);
  expect(p.edges.filter((e) => e.kind === "var").map((e) => [e.src, e.dstName])).toEqual([["src/sample.ts#Greeter.greet", "LIMIT"]]);
});

test("python entities and edges", async () => {
  const p = (await parseSource("app/sample.py", fx("sample.py")))!;
  expect(pick(p.entities)).toEqual([
    { name: "Store", kind: "class", fqName: "app/sample.py#Store", startLine: 7, endLine: 12 },
    { name: "get", kind: "method", fqName: "app/sample.py#Store.get", startLine: 8, endLine: 9 },
    { name: "put", kind: "method", fqName: "app/sample.py#Store.put", startLine: 11, endLine: 12 },
    { name: "lookup", kind: "function", fqName: "app/sample.py#lookup", startLine: 15, endLine: 16 },
  ]);
  expect(p.edges.filter((e) => e.kind === "call").map((e) => [e.src, e.dstName, e.line])).toEqual([
    ["app/sample.py#Store.get", "lookup", 9],
    ["app/sample.py#Store.put", "get", 12],
    ["app/sample.py#lookup", "join", 16],
    ["app/sample.py#lookup", "str", 16],
  ]);
  expect(p.edges.filter((e) => e.kind === "import").map((e) => e.dstName)).toEqual(["os", "pkg.mod", "thing", "other"]);
  expect(p.edges.filter((e) => e.kind === "var").map((e) => [e.src, e.dstName])).toEqual([["app/sample.py#Store.get", "THRESHOLD"]]);
});

test("chunks align with top-level entity boundaries", async () => {
  const src = fx("sample.ts");
  const p = (await parseSource("src/sample.ts", src))!;
  const chunks = chunkFile("src/sample.ts", src, p);
  const top = p.entities.filter((e) => e.kind !== "method");
  for (const e of top) expect(chunks.some((c) => c.startLine === e.startLine && c.endLine === e.endLine && c.symbolFq === e.fqName)).toBe(true);
  // leftovers (imports + const) are their own chunk ending right before the class
  expect(chunks[0]).toMatchObject({ startLine: 1, endLine: 5 });
  expect(chunks.every((c) => c.embedText.startsWith("// file: src/sample.ts | imports: node:fs/promises"))).toBe(true);
  expect(chunks.every((c) => /^[0-9a-f]{64}$/.test(c.contentHash))).toBe(true);
});

test("oversized class splits per method on method boundaries", async () => {
  const body = Array.from({ length: 3 }, (_, i) => `  m${i}() {\n${"    x();\n".repeat(250)}  }`).join("\n");
  const src = `class Big {\n${body}\n}\n`;
  const p = (await parseSource("big.ts", src))!;
  const chunks = chunkFile("big.ts", src, p);
  const methods = p.entities.filter((e) => e.kind === "method");
  expect(methods).toHaveLength(3);
  for (const m of methods) expect(chunks.some((c) => c.startLine === m.startLine && c.endLine === m.endLine && c.symbolFq === m.fqName)).toBe(true);
});
