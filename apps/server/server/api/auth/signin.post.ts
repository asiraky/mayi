import { Signin } from "@mayi/contracts";
import { createError, defineEventHandler, getHeader } from "h3";
import { bodyAs } from "../../utils/http";
import { database } from "../../utils/runtime";
import { createSession } from "../../utils/auth";
import { verifyPassword } from "../../utils/crypto";
import {
  authenticationClientAddress,
  clearAuthenticationAttempts,
  recordAuthenticationAttempt,
} from "../../utils/auth-rate-limit";

export default defineEventHandler(async (event) => {
  const input = await bodyAs(event, Signin);
  const source = authenticationClientAddress(event);
  await recordAuthenticationAttempt(`signin-source:${source}`, 30);
  const accountAttempt = await recordAuthenticationAttempt(`signin-account:${source}:${input.email.toLowerCase()}`, 20);
  const rows = await database().sql`
    select u.id, u.email, u.display_name, u.password_hash, m.workspace_id, w.name as workspace_name
    from users u join memberships m on m.user_id = u.id and m.active join workspaces w on w.id = m.workspace_id
    where lower(u.email) = lower(${input.email}) and u.active and u.deleted_at is null order by m.created_at limit 1
  `;
  const row = rows[0];
  if (!row || !await verifyPassword(input.password, String(row.password_hash))) throw createError({ statusCode: 401, statusMessage: "Email or password is incorrect" });
  const sessionToken = await createSession(event, String(row.id));
  await clearAuthenticationAttempts([accountAttempt]);
  return { user: { id: String(row.id), email: String(row.email), displayName: String(row.display_name) }, workspace: { id: String(row.workspace_id), name: String(row.workspace_name) }, ...(getHeader(event, "x-mayi-native") === "true" ? { sessionToken } : {}) };
});
