import { expect, test } from "vitest";
import { addendaFor, languageOf, versionNote } from "../src/index.ts";

test("language detection and per-language prompt addenda only for present languages", () => {
  expect(["a.py", "a.tsx", "a.go", "A.java", "a.rb", "a.md"].map(languageOf)).toEqual(["python", "typescript", "go", "java", "ruby", undefined]);
  const a = addendaFor(["x.py", "y.rb"]);
  expect(a).toContain("Python checklist");
  expect(a).toContain("Ruby checklist");
  expect(a).not.toContain("Go checklist");
  expect(addendaFor(["README.md"])).toBe("");
  expect(versionNote({ python: "3.13.1" })).toContain("python 3.13.1");
  expect(versionNote({})).toBe("");
});
