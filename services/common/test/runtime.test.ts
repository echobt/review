import { afterAll, expect, test } from "vitest";
import { readSecret, startHealthServer, memoryObjectStore } from "../src/index.ts";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const h = await startHealthServer("svc", 0, { db: async () => true, queue: async () => false });
afterAll(() => h.server.close());

test("healthz 200, readyz reflects dependency checks", async () => {
  const base = `http://127.0.0.1:${h.port}`;
  const l = await fetch(`${base}/healthz`);
  expect(l.status).toBe(200);
  expect(await l.json()).toEqual({ ok: true, service: "svc" });
  const r = await fetch(`${base}/readyz`);
  expect(r.status).toBe(503);
  expect((await r.json()).checks).toEqual({ db: true, queue: false });
});

test("readSecret prefers env then file", () => {
  const f = join(mkdtempSync(join(tmpdir(), "s-")), "k"); writeFileSync(f, "file-val\n");
  expect(readSecret("X", { X_FILE: f })).toBe("file-val");
  expect(readSecret("X", { X: "env", X_FILE: f })).toBe("env");
  expect(readSecret("X", {})).toBeUndefined();
});

test("memory object store round-trips", async () => {
  const s = memoryObjectStore();
  await s.put("tenants/t/a", Buffer.from("x"));
  expect((await s.get("tenants/t/a"))!.toString()).toBe("x");
  expect(await s.get("missing")).toBeUndefined();
});
