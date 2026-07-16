import { createDatabase, type Database } from "@mayi/db";
import { objectStoreFromEnv, type ObjectStore } from "@mayi/storage";

const state = globalThis as typeof globalThis & {
  __mayiDb?: Database;
  __mayiObjects?: ObjectStore;
  __mayiStrictlyPublicFetch?: boolean;
};

export function database(): Database {
  // Cloudflare Workers cannot share database sockets between requests, so the
  // worker entry point provides a per-request client through this store; every
  // other runtime keeps the process-wide pool.
  const perRequest = (globalThis as { __mayiRequestDatabase?: { getStore(): Database | undefined } })
    .__mayiRequestDatabase?.getStore();
  if (perRequest) return perRequest;
  return state.__mayiDb ??= createDatabase(process.env.DATABASE_URL);
}

export function objects(): ObjectStore {
  return state.__mayiObjects ??= objectStoreFromEnv();
}

export function configureEdgeRuntime(input: {
  databaseUrl?: string;
  objectStore?: ObjectStore;
  strictlyPublicFetch?: boolean;
}): void {
  if (input.databaseUrl && !state.__mayiDb) process.env.DATABASE_URL = input.databaseUrl;
  if (input.objectStore && !state.__mayiObjects) state.__mayiObjects = input.objectStore;
  if (input.strictlyPublicFetch !== undefined) state.__mayiStrictlyPublicFetch = input.strictlyPublicFetch;
}

export function strictlyPublicEdgeFetchConfigured(): boolean {
  return state.__mayiStrictlyPublicFetch === true;
}
