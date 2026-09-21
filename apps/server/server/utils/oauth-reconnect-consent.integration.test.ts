import { createId, sha256 } from "@mayi/contracts";
import { createApp, createRouter, toWebHandler } from "h3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import revokeAgent from "../api/agents/[id].delete";
import authorize from "../api/oauth/authorize.get";
import consent from "../api/oauth/consent.post";
import token from "../api/oauth/token.post";
import { tokenHash } from "./crypto";
import { database } from "./runtime";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://mayi:mayi@localhost:55432/mayi";
process.env.DATABASE_URL = DATABASE_URL;
process.env.SESSION_COOKIE_SECURE = "false";

const ids = {
  installer: createId(), installerWorkspace: createId(), installerSession: createId(),
  stranger: createId(), strangerWorkspace: createId(), strangerSession: createId(),
  client: createId(), agent: createId(),
};
const installerToken = `mayi_session_reconnect_installer_${createId()}`;
const strangerToken = `mayi_session_reconnect_stranger_${createId()}`;
const REDIRECT_URI = "https://client.example/callback";
const VERIFIER = `verifier-${createId()}`;

const app = createApp();
app.use(createRouter()
  .get("/api/oauth/authorize", authorize)
  .post("/api/oauth/consent", consent)
  .post("/api/oauth/token", token)
  .delete("/api/agents/:id", revokeAgent));
const handle = toWebHandler(app);

async function challenge(): Promise<string> {
  return Buffer.from(await sha256(VERIFIER), "hex").toString("base64url");
}

async function consentScreen(sessionToken: string, extra: Record<string, string>): Promise<Response> {
  const query = new URLSearchParams({
    response_type: "code", client_id: ids.client, redirect_uri: REDIRECT_URI,
    code_challenge: await challenge(), code_challenge_method: "S256", state: "xyz", ...extra,
  });
  return handle(new Request(`http://mayi.test/api/oauth/authorize?${query}`, {
    headers: { authorization: `Bearer ${sessionToken}` },
  }));
}

async function allow(sessionToken: string, extra: Record<string, string>): Promise<Response> {
  return handle(new Request("http://mayi.test/api/oauth/consent", {
    method: "POST",
    redirect: "manual",
    headers: { authorization: `Bearer ${sessionToken}`, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: ids.client, redirect_uri: REDIRECT_URI, code_challenge: await challenge(),
      scope: "approval:create approval:read", state: "xyz", decision: "approve", ...extra,
    }),
  }));
}

async function exchange(code: string): Promise<Response> {
  return handle(new Request("http://mayi.test/api/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: VERIFIER, client_id: ids.client, redirect_uri: REDIRECT_URI }),
  }));
}

describe.sequential("OAuth reconnect consent", () => {
  beforeAll(async () => {
    const sql = database().sql;
    for (const [user, workspace, session, sessionToken] of [
      [ids.installer, ids.installerWorkspace, ids.installerSession, installerToken],
      [ids.stranger, ids.strangerWorkspace, ids.strangerSession, strangerToken],
    ] as const) {
      await sql`insert into users (id, email, display_name, password_hash) values (${user}, ${`${user}@example.test`}, 'Reconnect test', 'unused')`;
      await sql`insert into workspaces (id, name) values (${workspace}, 'Reconnect test')`;
      await sql`insert into memberships (workspace_id, user_id, role) values (${workspace}, ${user}, 'OWNER')`;
      await sql`
        insert into sessions (id, user_id, token_hash, recent_auth_at, expires_at)
        values (${session}, ${user}, ${await tokenHash(sessionToken)}, now(), now() + interval '1 hour')
      `;
    }
    await sql`
      insert into oauth_clients (id, name, redirect_uris, approval_callback_uris, registration_ip_hash)
      values (${ids.client}, 'Reconnect client', ${[REDIRECT_URI]}, ${["https://client.example/approval"]}, ${"d".repeat(64)})
    `;
    await sql`
      insert into agents (id, workspace_id, name, client_id, scopes, credential_hash, credential_expires_at, created_by)
      values (${ids.agent}, ${ids.installerWorkspace}, 'Ledger install', ${ids.client}, ${["approval:read"]}, ${await tokenHash(`access-${ids.agent}`)}, now() + interval '1 hour', ${ids.installer})
    `;
  });

  afterAll(async () => {
    const sql = database().sql;
    await sql`delete from workspaces where id in ${sql([ids.installerWorkspace, ids.strangerWorkspace])}`;
    await sql`delete from oauth_clients where id = ${ids.client}`;
    await sql`delete from users where id in ${sql([ids.installer, ids.stranger])}`;
    await database().close();
  });

  it("offers the reconnect under the connection's existing name", async () => {
    const response = await consentScreen(installerToken, { connection: ids.agent });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Reconnect Ledger install?");
  });

  it("escapes a hostile label instead of rendering it", async () => {
    const response = await consentScreen(installerToken, { label: "<script>alert(1)</script>" });
    const html = await response.text();
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("stops a user from another workspace instead of creating a fresh connection", async () => {
    const screen = await consentScreen(strangerToken, { connection: ids.agent });
    expect(screen.status).toBe(409);
    expect(await screen.text()).not.toContain('action="/api/oauth/consent"');

    // The consent form is user-controlled, so posting it directly must fail as well.
    expect((await allow(strangerToken, { connection: ids.agent })).status).toBe(409);
    const codes = await database().sql`select 1 from oauth_codes where agent_id = ${ids.agent}`;
    expect(codes).toHaveLength(0);
  });

  it("carries the reconnect through consent to the same agent", async () => {
    const redirect = await allow(installerToken, { connection: ids.agent, label: "Ledger install (prod)" });
    expect(redirect.status).toBe(302);
    const location = new URL(redirect.headers.get("location")!);
    expect(location.searchParams.get("state")).toBe("xyz");

    const response = await exchange(location.searchParams.get("code")!);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ agent_id: ids.agent });
    const agents = await database().sql`select id, name from agents where client_id = ${ids.client}`;
    expect(agents).toEqual([expect.objectContaining({ id: ids.agent, name: "Ledger install (prod)" })]);
  });

  it("lets a racing owner revoke win over a reconnect without deadlocking", async () => {
    for (let round = 0; round < 5; round += 1) {
      const agentId = createId();
      await database().sql`
        insert into agents (id, workspace_id, name, client_id, scopes, credential_hash, credential_expires_at, created_by)
        values (${agentId}, ${ids.installerWorkspace}, 'Racing install', ${ids.client}, ${["approval:read"]}, ${await tokenHash(`access-${agentId}`)}, now() + interval '1 hour', ${ids.installer})
      `;
      await database().sql`
        insert into refresh_tokens (id, agent_id, family_id, token_hash, expires_at)
        values (${createId()}, ${agentId}, ${createId()}, ${await tokenHash(`refresh-${agentId}`)}, now() + interval '30 days')
      `;
      const redirect = await allow(installerToken, { connection: agentId });
      const code = new URL(redirect.headers.get("location")!).searchParams.get("code")!;
      const [exchanged, revoked] = await Promise.all([
        exchange(code),
        handle(new Request(`http://mayi.test/api/agents/${agentId}`, { method: "DELETE", headers: { authorization: `Bearer ${installerToken}` } })),
      ]);
      // Whichever runs first, the revoke always lands and always has the last word.
      expect(revoked.status).toBe(200);
      expect([200, 400]).toContain(exchanged.status);
      const [agent] = await database().sql`select revoked_by, credential_hash from agents where id = ${agentId}`;
      expect(agent).toMatchObject({ revoked_by: ids.installer, credential_hash: null });
      const live = await database().sql`select 1 from refresh_tokens where agent_id = ${agentId} and revoked_at is null`;
      expect(live).toHaveLength(0);
    }
  });

  it("treats an owner revoke as final, even over an automatic revoke", async () => {
    // Refresh-token reuse leaves the connection revoked but reconnectable...
    await database().sql`update agents set revoked_at = now(), credential_hash = null where id = ${ids.agent}`;
    expect((await consentScreen(installerToken, { connection: ids.agent })).status).toBe(200);
    // ...until an owner revokes it on purpose.
    const revoked = await handle(new Request(`http://mayi.test/api/agents/${ids.agent}`, {
      method: "DELETE", headers: { authorization: `Bearer ${installerToken}` },
    }));
    expect(revoked.status).toBe(200);
    expect((await consentScreen(installerToken, { connection: ids.agent })).status).toBe(409);
    expect((await allow(installerToken, { connection: ids.agent })).status).toBe(409);
  });
});
