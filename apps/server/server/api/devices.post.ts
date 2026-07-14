import { z } from "zod";
import { defineEventHandler } from "h3";
import { requireUser } from "../utils/auth";
import { bodyAs } from "../utils/http";
import { database } from "../utils/runtime";

const Device = z.object({ token: z.string().startsWith("ExponentPushToken[").max(255), platform: z.enum(["ios", "android"]) });

export default defineEventHandler(async (event) => {
  const auth = await requireUser(event);
  const input = await bodyAs(event, Device);
  await database().sql`
    insert into devices (user_id, workspace_id, expo_push_token, platform) values (${auth.userId}, ${auth.workspaceId}, ${input.token}, ${input.platform})
    on conflict (expo_push_token) do update set user_id = excluded.user_id, workspace_id = excluded.workspace_id, active = true, last_seen_at = now()
  `;
  return { ok: true };
});
