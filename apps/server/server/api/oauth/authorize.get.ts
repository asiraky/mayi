import { createError, defineEventHandler, getQuery, sendRedirect } from "h3";
import { requireUser } from "../../utils/auth";
import { database } from "../../utils/runtime";

function escape(value: string): string { return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!); }

export default defineEventHandler(async (event) => {
  const query = getQuery(event);
  const clientId = String(query.client_id ?? "");
  const redirectUri = String(query.redirect_uri ?? "");
  const challenge = String(query.code_challenge ?? "");
  const scope = String(query.scope ?? "approval:create approval:read approval:cancel");
  if (query.response_type !== "code" || query.code_challenge_method !== "S256" || !challenge) throw createError({ statusCode: 400, statusMessage: "Authorization code with PKCE S256 is required" });
  let auth;
  try { auth = await requireUser(event); } catch { return sendRedirect(event, `/?signin=1&returnTo=${encodeURIComponent(event.node.req.url ?? event.path)}`); }
  const clients = await database().sql`select name, redirect_uris from oauth_clients where id = ${clientId}`;
  const client = clients[0];
  if (!client || !(client.redirect_uris as string[]).includes(redirectUri)) throw createError({ statusCode: 400, statusMessage: "Client or redirect URI is not registered" });
  const scopes = scope.split(" ").filter(Boolean);
  const allowed = new Set(["approval:create", "approval:read", "approval:cancel"]);
  if (!scopes.length || scopes.some((item) => !allowed.has(item))) throw createError({ statusCode: 400, statusMessage: "Unsupported scope" });
  event.node.res.setHeader("content-type", "text/html; charset=utf-8");
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width"><title>Connect agent</title><style>body{font:16px system-ui;max-width:600px;margin:10vh auto;padding:24px;color:#17201c}button{padding:12px 18px;margin-right:8px}.card{border:1px solid #ccd5d0;border-radius:16px;padding:24px}</style></head><body><main class="card"><h1>Connect ${escape(String(client.name))}?</h1><p>This agent requests access to <strong>${escape(scope)}</strong> in your current workspace.</p><form method="post" action="/api/oauth/consent"><input type="hidden" name="client_id" value="${escape(clientId)}"><input type="hidden" name="redirect_uri" value="${escape(redirectUri)}"><input type="hidden" name="code_challenge" value="${escape(challenge)}"><input type="hidden" name="scope" value="${escape(scope)}"><input type="hidden" name="state" value="${escape(String(query.state ?? ""))}"><button name="decision" value="approve">Allow</button><button name="decision" value="deny">Deny</button></form></main></body></html>`;
});
