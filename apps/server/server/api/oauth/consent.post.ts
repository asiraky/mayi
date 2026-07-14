import { createError, defineEventHandler, readBody, sendRedirect } from "h3";
import { requireUser, audit } from "../../utils/auth";
import { database } from "../../utils/runtime";
import { randomToken, tokenHash } from "../../utils/crypto";

export default defineEventHandler(async (event) => {
  const auth = await requireUser(event);
  const body = await readBody<Record<string, string>>(event);
  const clients = await database().sql`select redirect_uris from oauth_clients where id = ${body.client_id ?? ""}`;
  if (!clients[0] || !(clients[0].redirect_uris as string[]).includes(body.redirect_uri ?? "")) throw createError({ statusCode: 400, statusMessage: "Invalid client redirect" });
  const target = new URL(body.redirect_uri!);
  if (body.state) target.searchParams.set("state", body.state);
  if (body.decision !== "approve") { target.searchParams.set("error", "access_denied"); return sendRedirect(event, target.toString()); }
  const code = randomToken();
  const scopes = String(body.scope ?? "").split(" ").filter(Boolean);
  await database().sql`
    insert into oauth_codes (code_hash, workspace_id, user_id, client_id, redirect_uri, code_challenge, scopes, expires_at)
    values (${await tokenHash(code)}, ${auth.workspaceId}, ${auth.userId}, ${body.client_id!}, ${body.redirect_uri!}, ${body.code_challenge!}, ${scopes}, now() + interval '5 minutes')
  `;
  await audit({ workspaceId: auth.workspaceId, actorType: "user", actorId: auth.userId, eventType: "agent.consent_granted", subjectType: "workspace", subjectId: auth.workspaceId, metadata: { clientId: body.client_id, scopes } });
  target.searchParams.set("code", code);
  return sendRedirect(event, target.toString());
});
