import { expect, test } from "vitest";
import { EnvelopeCipher, LocalKms, VaultTransitKms } from "../src/index.ts";

test("round-trips, binds ciphertext to tenant + context, caches DEKs", async () => {
  const kms = new LocalKms();
  const c = new EnvelopeCipher(kms);
  const ct = await c.encrypt("t1", "export const secret = 1;", "a.ts");
  expect(ct.includes(Buffer.from("secret"))).toBe(false);
  expect((await c.decrypt("t1", ct, "a.ts")).toString()).toBe("export const secret = 1;");
  await expect(c.decrypt("t2", ct, "a.ts")).rejects.toThrow();
  await expect(c.decrypt("t1", ct, "b.ts")).rejects.toThrow();
  const calls = kms.calls;
  await c.encrypt("t1", "x");
  expect(kms.calls).toBe(calls); // DEK reused within TTL
});

test("DEK TTL is capped at 5 minutes and KEK revocation makes data unreadable", async () => {
  let now = 0;
  const kms = new LocalKms();
  const c = new EnvelopeCipher(kms, { ttlMs: 3_600_000, now: () => now });
  const ct = await c.encrypt("t1", "data");
  kms.revoke("t1");
  expect((await c.decrypt("t1", ct)).toString()).toBe("data"); // cached
  now += 300_001;
  await expect(c.decrypt("t1", ct)).rejects.toThrow(/revoked/);
});

test("LocalKms with master key is deterministic across instances", async () => {
  const master = Buffer.alloc(32, 7);
  const ct = await new EnvelopeCipher(new LocalKms(master)).encrypt("t1", "hello");
  expect((await new EnvelopeCipher(new LocalKms(master)).decrypt("t1", ct)).toString()).toBe("hello");
});

test("VaultTransitKms speaks the transit API and never puts the token in the URL", async () => {
  const seen: { url: string; token: string | null }[] = [];
  const f = (async (u: string | URL | Request, init?: RequestInit) => {
    const url = String(u); seen.push({ url, token: new Headers(init?.headers).get("x-vault-token") });
    const body = JSON.parse(String(init?.body));
    return Response.json({ data: url.includes("/encrypt/") ? { ciphertext: `vault:v1:${body.plaintext}` } : { plaintext: String(body.ciphertext).slice(9) } });
  }) as typeof fetch;
  const kms = new VaultTransitKms({ addr: "http://vault.test/", token: "s.tok", fetch: f });
  const c = new EnvelopeCipher(kms);
  const ct = await c.encrypt("t-1", "x");
  expect((await c.decrypt("t-1", ct)).toString()).toBe("x");
  expect(seen[0]!.url).toBe("http://vault.test/v1/transit/encrypt/tenant-t-1");
  expect(seen.every((s) => s.token === "s.tok" && !s.url.includes("s.tok"))).toBe(true);
});
