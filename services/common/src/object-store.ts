import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

/** Object store port. Keys are always tenant-prefixed (tenantKey from @review/queue). */
export interface ObjectStore {
  put(key: string, body: Buffer): Promise<void>;
  get(key: string): Promise<Buffer | undefined>;
}

export function memoryObjectStore(): ObjectStore & { keys(): string[] } {
  const m = new Map<string, Buffer>();
  return {
    async put(k, b) { m.set(k, Buffer.from(b)); },
    async get(k) { return m.get(k); },
    keys: () => [...m.keys()],
  };
}

/** S3 / MinIO. Credentials come from the standard AWS env/credential chain, never from code. */
export function s3ObjectStore(opts: { endpoint?: string; bucket: string; region: string }): ObjectStore {
  const s3 = new S3Client({ region: opts.region, ...(opts.endpoint ? { endpoint: opts.endpoint, forcePathStyle: true } : {}) });
  return {
    async put(key, body) { await s3.send(new PutObjectCommand({ Bucket: opts.bucket, Key: key, Body: body })); },
    async get(key) {
      try {
        const r = await s3.send(new GetObjectCommand({ Bucket: opts.bucket, Key: key }));
        return r.Body ? Buffer.from(await r.Body.transformToByteArray()) : undefined;
      } catch (e) {
        if ((e as { name?: string }).name === "NoSuchKey") return undefined;
        throw e;
      }
    },
  };
}
