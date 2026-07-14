import { GetObjectCommand, PutObjectCommand, S3Client, type S3ClientConfig } from "@aws-sdk/client-s3";

export interface ObjectStore {
  putImmutable(key: string, bytes: Uint8Array, mediaType: string): Promise<void>;
  get(key: string): Promise<{ bytes: Uint8Array; mediaType?: string }>;
}

export interface R2BucketLike {
  put(key: string, value: Uint8Array, options?: { onlyIf?: { etagDoesNotMatch: string }; httpMetadata?: { contentType: string }; customMetadata?: Record<string, string> }): Promise<unknown>;
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer>; httpMetadata?: { contentType?: string } } | null>;
}

export class R2ObjectStore implements ObjectStore {
  constructor(private readonly bucket: R2BucketLike) {}
  async putImmutable(key: string, bytes: Uint8Array, mediaType: string): Promise<void> {
    const result = await this.bucket.put(key, bytes, { onlyIf: { etagDoesNotMatch: "*" }, httpMetadata: { contentType: mediaType }, customMetadata: { immutable: "true" } });
    if (!result) throw new Error("Object already exists");
  }
  async get(key: string): Promise<{ bytes: Uint8Array; mediaType?: string }> {
    const object = await this.bucket.get(key); if (!object) throw new Error("Object not found");
    const response: { bytes: Uint8Array; mediaType?: string } = { bytes: new Uint8Array(await object.arrayBuffer()) };
    if (object.httpMetadata?.contentType) response.mediaType = object.httpMetadata.contentType;
    return response;
  }
}

export class FileObjectStore implements ObjectStore {
  constructor(private readonly root: string) {}

  private async pathFor(key: string): Promise<string> {
    const path = await import("node:path");
    const safe = key.replace(/[^a-zA-Z0-9/_-]/g, "_");
    const full = path.resolve(this.root, safe);
    const root = path.resolve(this.root);
    if (!full.startsWith(`${root}${path.sep}`)) throw new Error("Invalid object key");
    return full;
  }

  async putImmutable(key: string, bytes: Uint8Array): Promise<void> {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const target = await this.pathFor(key);
    await fs.mkdir(path.dirname(target), { recursive: true });
    const handle = await fs.open(target, "wx");
    try { await handle.writeFile(bytes); } finally { await handle.close(); }
  }

  async get(key: string): Promise<{ bytes: Uint8Array }> {
    const fs = await import("node:fs/promises");
    return { bytes: new Uint8Array(await fs.readFile(await this.pathFor(key))) };
  }
}

export class S3ObjectStore implements ObjectStore {
  private readonly client: S3Client;
  constructor(private readonly bucket: string, options: S3ClientConfig) {
    this.client = new S3Client(options);
  }

  async putImmutable(key: string, bytes: Uint8Array, mediaType: string): Promise<void> {
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket, Key: key, Body: bytes, ContentType: mediaType,
      IfNoneMatch: "*", Metadata: { immutable: "true" },
    }));
  }

  async get(key: string): Promise<{ bytes: Uint8Array; mediaType?: string }> {
    const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!result.Body) throw new Error("Object has no body");
    const response: { bytes: Uint8Array; mediaType?: string } = { bytes: await result.Body.transformToByteArray() };
    if (result.ContentType) response.mediaType = result.ContentType;
    return response;
  }
}

export function objectStoreFromEnv(env: Record<string, string | undefined> = process.env): ObjectStore {
  if (env.OBJECT_STORE === "s3") {
    if (!env.S3_BUCKET) throw new Error("S3_BUCKET is required");
    return new S3ObjectStore(env.S3_BUCKET, {
      region: env.S3_REGION ?? "auto",
      forcePathStyle: env.S3_FORCE_PATH_STYLE === "true",
      ...(env.S3_ENDPOINT ? { endpoint: env.S3_ENDPOINT } : {}),
      ...(env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY ? { credentials: {
        accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY,
      } } : {}),
    });
  }
  return new FileObjectStore(env.OBJECT_DIRECTORY ?? "./data/objects");
}
