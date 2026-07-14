import { createDatabase, type Database } from "@mayi/db";
import { objectStoreFromEnv, type ObjectStore } from "@mayi/storage";

const state = globalThis as typeof globalThis & { __mayiDb?: Database; __mayiObjects?: ObjectStore };

export function database(): Database {
  return state.__mayiDb ??= createDatabase(process.env.DATABASE_URL);
}

export function objects(): ObjectStore {
  return state.__mayiObjects ??= objectStoreFromEnv();
}

export function configureEdgeRuntime(input: { databaseUrl?: string; objectStore?: ObjectStore }): void {
  if (input.databaseUrl && !state.__mayiDb) process.env.DATABASE_URL = input.databaseUrl;
  if (input.objectStore && !state.__mayiObjects) state.__mayiObjects = input.objectStore;
}
