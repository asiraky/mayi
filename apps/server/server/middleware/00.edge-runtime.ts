import { defineEventHandler } from "h3";
import { R2ObjectStore, type R2BucketLike } from "@mayi/storage";
import { configureEdgeRuntime } from "../utils/runtime";

export default defineEventHandler((event) => {
  const cloudflare = (event.context as { cloudflare?: { env?: { HYPERDRIVE?: { connectionString?: string }; ARTEFACTS?: R2BucketLike } } }).cloudflare;
  if (cloudflare?.env) configureEdgeRuntime({
    ...(cloudflare.env.HYPERDRIVE?.connectionString ? { databaseUrl: cloudflare.env.HYPERDRIVE.connectionString } : {}),
    ...(cloudflare.env.ARTEFACTS ? { objectStore: new R2ObjectStore(cloudflare.env.ARTEFACTS) } : {}),
  });
});
