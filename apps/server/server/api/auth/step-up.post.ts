import { Signin } from "@mayi/contracts";
import { createError, defineEventHandler } from "h3";
import { bodyAs } from "../../utils/http";
import { requireUser, audit } from "../../utils/auth";
import { database } from "../../utils/runtime";
import { verifyPassword } from "../../utils/crypto";

export default defineEventHandler(async (event) => {
  const auth = await requireUser(event); const input = await bodyAs(event, Signin);
  const rows = await database().sql`select email, password_hash from users where id = ${auth.userId} and active and deleted_at is null`;
  const user = rows[0];
  if (!user || String(user.email).toLowerCase() !== input.email.toLowerCase() || !await verifyPassword(input.password, String(user.password_hash))) throw createError({ statusCode: 401, statusMessage: "Authentication failed" });
  await database().sql`update sessions set recent_auth_at = now() where id = ${auth.sessionId} and user_id = ${auth.userId}`;
  await audit({ workspaceId: auth.workspaceId, actorType: "user", actorId: auth.userId, eventType: "auth.step_up", subjectType: "session", subjectId: auth.sessionId });
  return { ok: true };
});
