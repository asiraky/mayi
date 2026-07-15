import worker from "../apps/server/.output/server/index.mjs";
import { boundCloudflareRequest } from "./bounded-request";

type Env = { CRON_SECRET: string } & Record<string, unknown>;
type Worker = { fetch(request: Request, env: Env, context: unknown): Promise<Response> };

export default {
  async fetch(request: Request, env: Env, context: unknown) {
    const bounded = await boundCloudflareRequest(request);
    if (bounded instanceof Response) return bounded;
    return (worker as Worker).fetch(bounded, env, context);
  },
  scheduled(_controller: unknown, env: Env, context: { waitUntil(value: Promise<unknown>): void }) {
    const request = new Request("https://internal.invalid/api/internal/jobs/drain", {
      method: "POST", headers: { authorization: `Bearer ${env.CRON_SECRET}` },
    });
    context.waitUntil((worker as Worker).fetch(request, env, context));
  },
};
