import { drizzle } from "drizzle-orm/postgres-js";
import postgres, { type Sql, type TransactionSql } from "postgres";
import * as schema from "./schema";

export * from "./schema";

export type DatabaseSql = Sql | TransactionSql;

export function createDatabase(url = process.env.DATABASE_URL) {
  if (!url) throw new Error("DATABASE_URL is required");
  const client = postgres(url, { max: 10, idle_timeout: 20, prepare: false });
  return { db: drizzle(client, { schema }), sql: client, close: () => client.end() };
}

export type Database = ReturnType<typeof createDatabase>;
