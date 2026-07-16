import { AsyncLocalStorage } from "node:async_hooks";
import { createDatabase, type Database } from "../packages/db/src/index";
import worker from "../apps/server/.output/server/index.mjs";
import { boundCloudflareRequest } from "./bounded-request";

type Env = { CRON_SECRET: string; HYPERDRIVE?: { connectionString?: string } } & Record<string, unknown>;
type Context = { waitUntil(value: Promise<unknown>): void };
type Worker = { fetch(request: Request, env: Env, context: Context): Promise<Response> };

// Workers forbid using a socket opened during one request from another request,
// so the PostgreSQL client must live and die within a single invocation. The
// application resolves its database through this store (see the server's
// runtime utils); Hyperdrive holds the real cross-request connection pool.
const requestDatabase = new AsyncLocalStorage<Database>();
(globalThis as Record<string, unknown>).__mayiRequestDatabase = requestDatabase;

async function withRequestDatabase<T>(env: Env, context: Context, run: () => Promise<T>): Promise<T> {
  const url = env.HYPERDRIVE?.connectionString;
  if (!url) return run();
  const database = createDatabase(url);
  try {
    return await requestDatabase.run(database, run);
  } finally {
    context.waitUntil(database.close().catch(() => undefined));
  }
}

export default {
  async fetch(request: Request, env: Env, context: Context) {
    const bounded = await boundCloudflareRequest(request);
    if (bounded instanceof Response) return bounded;
    return withRequestDatabase(env, context, () => (worker as Worker).fetch(bounded, env, context));
  },
  scheduled(_controller: unknown, env: Env, context: Context) {
    const request = new Request("https://internal.invalid/api/internal/jobs/drain", {
      method: "POST", headers: { authorization: `Bearer ${env.CRON_SECRET}` },
    });
    context.waitUntil(withRequestDatabase(env, context, () => (worker as Worker).fetch(request, env, context)));
  },
};
