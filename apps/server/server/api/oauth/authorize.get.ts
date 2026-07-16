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
  try {
    await requireUser(event);
  } catch (error) {
    // Only a missing/expired session means "go sign in"; a server failure must
    // surface instead of bouncing the user to a sign-in page they can't use.
    const statusCode = (error as { statusCode?: number }).statusCode;
    if (statusCode !== 401 && statusCode !== 403) throw error;
    return sendRedirect(event, `/?signin=1&returnTo=${encodeURIComponent(event.node.req.url ?? event.path)}`);
  }
  const clients = await database().sql`select name, redirect_uris from oauth_clients where id = ${clientId}`;
  const client = clients[0];
  if (!client || !(client.redirect_uris as string[]).includes(redirectUri)) throw createError({ statusCode: 400, statusMessage: "Client or redirect URI is not registered" });
  const scopes = scope.split(" ").filter(Boolean);
  const allowed = new Set(["approval:create", "approval:read", "approval:cancel"]);
  if (!scopes.length || scopes.some((item) => !allowed.has(item))) throw createError({ statusCode: 400, statusMessage: "Unsupported scope" });
  // Human-readable names for the scopes the consent card lists. The raw scope
  // string still travels through the hidden form field untouched.
  const scopeLabels: Record<string, string> = {
    "approval:create": "Create approval requests",
    "approval:read": "Read approvals",
    "approval:cancel": "Cancel approvals",
  };
  const scopeItems = scopes.map((item) => `<li>${escape(scopeLabels[item] ?? item)}</li>`).join("");
  event.node.res.setHeader("content-type", "text/html; charset=utf-8");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Connect agent — May I?</title><style>
:root{color-scheme:light dark;--background:#ecedeb;--card:#f8f9f7;--ink:#15181a;--body:#4a5250;--muted:#6b7472;--border:rgba(21,24,26,.12);--primary:#3d2fd6;--primary-hover:#2a1fb0;--primary-foreground:#ecedeb}
@media (prefers-color-scheme:dark){:root{--background:#121514;--card:#191d1c;--ink:#e8eae7;--body:#b3bbb8;--muted:#8a938f;--border:rgba(232,234,231,.12);--primary-hover:#4c40fe}}
*{box-sizing:border-box}
body{margin:0;padding:24px 16px 48px;background:var(--background);color:var(--ink);font-family:"Plus Jakarta Sans",-apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Roboto,sans-serif;font-size:16px;line-height:1.5;-webkit-font-smoothing:antialiased;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center}
.wrap{width:100%;max-width:420px}
.wordmark{font-size:15px;font-weight:600;letter-spacing:-0.01em;color:var(--ink);margin:0 0 20px}
.card{background:var(--card);border:1px solid var(--border);border-radius:16px;padding:28px 24px}
.kicker{color:var(--muted);font-size:11px;font-weight:500;letter-spacing:.09em;text-transform:uppercase;margin:0 0 10px}
h1{font-size:22px;line-height:1.25;font-weight:600;letter-spacing:-0.01em;margin:0 0 12px;overflow-wrap:break-word}
.prose{color:var(--body);font-size:15px;margin:0 0 8px}
.scopes{margin:0 0 24px;padding:0;list-style:none}
.scopes li{color:var(--body);font-size:15px;padding:9px 0 9px 24px;border-top:1px solid var(--border);position:relative}
.scopes li::before{content:"";position:absolute;left:4px;top:50%;width:6px;height:6px;margin-top:-3px;border-radius:50%;background:var(--primary)}
.actions{display:flex;flex-direction:column;gap:10px}
button{appearance:none;width:100%;min-height:44px;padding:12px 18px;border-radius:10px;font:inherit;font-size:15px;font-weight:600;cursor:pointer}
.allow{background:var(--primary);border:1px solid var(--primary);color:var(--primary-foreground)}
.allow:hover{background:var(--primary-hover);border-color:var(--primary-hover)}
.deny{background:transparent;border:1px solid var(--border);color:var(--ink)}
.deny:hover{border-color:var(--muted)}
button:focus-visible{outline:2px solid var(--primary);outline-offset:2px}
.footnote{color:var(--muted);font-size:12px;line-height:1.5;margin:20px 0 0}
@media (min-width:480px){.actions{flex-direction:row}.actions button{width:auto;flex:1}}
</style></head><body><div class="wrap"><p class="wordmark">May I?</p><main class="card"><p class="kicker">Connection request</p><h1>Connect ${escape(String(client.name))}?</h1><p class="prose">This agent is asking to act in your current workspace. It will be able to:</p><ul class="scopes">${scopeItems}</ul><form method="post" action="/api/oauth/consent"><input type="hidden" name="client_id" value="${escape(clientId)}"><input type="hidden" name="redirect_uri" value="${escape(redirectUri)}"><input type="hidden" name="code_challenge" value="${escape(challenge)}"><input type="hidden" name="scope" value="${escape(scope)}"><input type="hidden" name="state" value="${escape(String(query.state ?? ""))}"><div class="actions"><button class="allow" name="decision" value="approve">Allow</button><button class="deny" name="decision" value="deny">Deny</button></div></form></main><p class="footnote">Denying returns you to the agent without granting any access.</p></div></body></html>`;
});
