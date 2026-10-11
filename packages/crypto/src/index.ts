import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { z } from "zod";

/** KMS boundary (ADR 0007). Implementations: LocalKms (dev/test), VaultTransitKms (self-host), cloud KMS later. */
export interface Kms {
  /** Wrap (encrypt) a data key under the tenant's KEK. */
  wrap(tenantId: string, dek: Buffer): Promise<string>;
  unwrap(tenantId: string, wrapped: string): Promise<Buffer>;
}

const gcm = {
  seal(key: Buffer, plaintext: Buffer, aad: Buffer): Buffer {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", key, iv);
    c.setAAD(aad);
    const ct = Buffer.concat([c.update(plaintext), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), ct]);
  },
  open(key: Buffer, sealed: Buffer, aad: Buffer): Buffer {
    const d = createDecipheriv("aes-256-gcm", key, sealed.subarray(0, 12));
    d.setAAD(aad);
    d.setAuthTag(sealed.subarray(12, 28));
    return Buffer.concat([d.update(sealed.subarray(28)), d.final()]);
  },
};

/**
 * Mock/dev KMS: one random KEK per tenant held in memory, or derived from a master key when given.
 * `revoke` simulates KEK deletion (crypto-shredding).
 */
export class LocalKms implements Kms {
  readonly #keks = new Map<string, Buffer>();
  readonly #revoked = new Set<string>();
  readonly #master: Buffer | undefined;
  calls = 0;
  constructor(masterKey?: Buffer) {
    if (masterKey && masterKey.length !== 32) throw new Error("LocalKms master key must be 32 bytes");
    this.#master = masterKey;
  }
  #kek(tenantId: string): Buffer {
    if (this.#revoked.has(tenantId)) throw new Error("KEK revoked");
    let k = this.#keks.get(tenantId);
    if (!k) {
      k = this.#master ? gcmKdf(this.#master, tenantId) : randomBytes(32);
      this.#keks.set(tenantId, k);
    }
    return k;
  }
  async wrap(tenantId: string, dek: Buffer) { this.calls++; return gcm.seal(this.#kek(tenantId), dek, Buffer.from(tenantId)).toString("base64"); }
  async unwrap(tenantId: string, wrapped: string) { this.calls++; return gcm.open(this.#kek(tenantId), Buffer.from(wrapped, "base64"), Buffer.from(tenantId)); }
  revoke(tenantId: string) { this.#revoked.add(tenantId); this.#keks.delete(tenantId); }
}

/** Per-tenant KEK = HKDF-SHA256(master, info="tenant-kek:<id>"). */
const gcmKdf = (master: Buffer, tenantId: string): Buffer =>
  Buffer.from(hkdfSync("sha256", master, Buffer.alloc(0), Buffer.from(`tenant-kek:${tenantId}`), 32));

/**
 * HashiCorp Vault transit engine (real boundary). Key name per tenant: `tenant-<id>`.
 * Uses POST /v1/transit/encrypt/:name and /decrypt/:name. Token is read by the caller from env/secret file.
 */
export class VaultTransitKms implements Kms {
  readonly #addr: string; readonly #token: string; readonly #fetch: typeof fetch; readonly #mount: string;
  constructor(opts: { addr: string; token: string; mount?: string; fetch?: typeof fetch }) {
    this.#addr = opts.addr.replace(/\/$/, ""); this.#token = opts.token; this.#mount = opts.mount ?? "transit"; this.#fetch = opts.fetch ?? fetch;
  }
  async #call(op: "encrypt" | "decrypt", tenantId: string, body: object) {
    if (!/^[A-Za-z0-9-]+$/.test(tenantId)) throw new Error("invalid tenant id for KMS key name");
    const res = await this.#fetch(`${this.#addr}/v1/${this.#mount}/${op}/tenant-${tenantId}`, {
      method: "POST", headers: { "x-vault-token": this.#token, "content-type": "application/json" }, body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`vault transit ${op}: HTTP ${res.status}`);
    return z.object({ data: z.record(z.string(), z.string()) }).parse(await res.json()).data;
  }
  async wrap(tenantId: string, dek: Buffer) { return (await this.#call("encrypt", tenantId, { plaintext: dek.toString("base64") })).ciphertext!; }
  async unwrap(tenantId: string, wrapped: string) { return Buffer.from((await this.#call("decrypt", tenantId, { ciphertext: wrapped })).plaintext!, "base64"); }
}

const MAGIC = Buffer.from("RV1");

/**
 * Envelope encryption: one DEK per (tenant, cache window); ciphertext = MAGIC | len(wrapped) | wrapped DEK | GCM blob.
 * DEKs are cached <= ttlMs (default 5 min) so KEK revocation takes effect quickly (ADR 0007).
 */
export class EnvelopeCipher {
  readonly #kms: Kms; readonly #ttlMs: number; readonly #now: () => number;
  readonly #enc = new Map<string, { dek: Buffer; wrapped: string; at: number }>();
  readonly #dec = new Map<string, { dek: Buffer; at: number }>();
  constructor(kms: Kms, opts: { ttlMs?: number; now?: () => number } = {}) {
    this.#kms = kms; this.#ttlMs = Math.min(opts.ttlMs ?? 300_000, 300_000); this.#now = opts.now ?? Date.now;
  }
  async encrypt(tenantId: string, plaintext: Buffer | string, context = ""): Promise<Buffer> {
    let e = this.#enc.get(tenantId);
    if (!e || this.#now() - e.at > this.#ttlMs) {
      const dek = randomBytes(32);
      e = { dek, wrapped: await this.#kms.wrap(tenantId, dek), at: this.#now() };
      this.#enc.set(tenantId, e);
      this.#dec.set(`${tenantId}|${e.wrapped}`, { dek, at: e.at });
    }
    const w = Buffer.from(e.wrapped, "utf8");
    const len = Buffer.alloc(2); len.writeUInt16BE(w.length);
    const pt = typeof plaintext === "string" ? Buffer.from(plaintext, "utf8") : plaintext;
    return Buffer.concat([MAGIC, len, w, gcm.seal(e.dek, pt, Buffer.from(`${tenantId}|${context}`))]);
  }
  async decrypt(tenantId: string, blob: Buffer, context = ""): Promise<Buffer> {
    if (!blob.subarray(0, 3).equals(MAGIC)) throw new Error("not an envelope ciphertext");
    const n = blob.readUInt16BE(3);
    const wrapped = blob.subarray(5, 5 + n).toString("utf8");
    const key = `${tenantId}|${wrapped}`;
    let d = this.#dec.get(key);
    if (!d || this.#now() - d.at > this.#ttlMs) { d = { dek: await this.#kms.unwrap(tenantId, wrapped), at: this.#now() }; this.#dec.set(key, d); }
    return gcm.open(d.dek, blob.subarray(5 + n), Buffer.from(`${tenantId}|${context}`));
  }
}
