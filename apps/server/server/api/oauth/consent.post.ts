import { createError, defineEventHandler, sendRedirect } from "h3";
import { z } from "zod";
import { requireUser, audit } from "../../utils/auth";
import { database } from "../../utils/runtime";
import { randomToken, tokenHash } from "../../utils/crypto";
import { readBoundedJsonOrFormBody } from "../../utils/http";
import { findReconnectTarget, parseConnectionId, parseConnectionLabel } from "../../utils/oauth-connection";

export default defineEventHandler(async (event) => {
  const auth = await requireUser(event);
  const parsed = z.record(z.string(), z.string()).safeParse(await readBoundedJsonOrFormBody(event, 32 * 1024));
  if (!parsed.success) throw createError({ statusCode: 400, statusMessage: "Invalid consent request" });
  const body = parsed.data;
  const clients = await database().sql`select redirect_uris from oauth_clients where id = ${body.client_id ?? ""}`;
  if (!clients[0] || !(clients[0].redirect_uris as string[]).includes(body.redirect_uri ?? "")) throw createError({ statusCode: 400, statusMessage: "Invalid client redirect" });
  const target = new URL(body.redirect_uri!);
  if (body.state) target.searchParams.set("state", body.state);
  if (body.decision !== "approve") { target.searchParams.set("error", "access_denied"); return sendRedirect(event, target.toString()); }
  // The form fields are user-controlled, so the reconnect target is re-checked here
  // rather than trusted from the consent page that rendered them.
  const label = parseConnectionLabel(body.label);
  const connection = parseConnectionId(body.connection);
  if (connection) {
    const reconnect = await findReconnectTarget(database().sql, { agentId: connection, clientId: body.client_id!, workspaceId: auth.workspaceId });
    if (reconnect.status !== "ok") throw createError({ statusCode: 409, statusMessage: "This connection cannot be reconnected from this workspace" });
  }
  const code = randomToken();
  const scopes = String(body.scope ?? "").split(" ").filter(Boolean);
  await database().sql`
    insert into oauth_codes (code_hash, workspace_id, user_id, client_id, redirect_uri, code_challenge, scopes, agent_id, label, expires_at)
    values (${await tokenHash(code)}, ${auth.workspaceId}, ${auth.userId}, ${body.client_id!}, ${body.redirect_uri!}, ${body.code_challenge!}, ${scopes}, ${connection}, ${label}, now() + interval '5 minutes')
  `;
  await audit({ workspaceId: auth.workspaceId, actorType: "user", actorId: auth.userId, eventType: "agent.consent_granted", subjectType: "workspace", subjectId: auth.workspaceId, metadata: { clientId: body.client_id, scopes, ...(connection ? { reconnects: connection } : {}) } });
  target.searchParams.set("code", code);
  return sendRedirect(event, target.toString());
});
