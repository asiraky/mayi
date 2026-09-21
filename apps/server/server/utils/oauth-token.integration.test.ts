import { createId, sha256 } from "@mayi/contracts";
import { createApp, createRouter, toWebHandler } from "h3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import oauthToken from "../api/oauth/token.post";
import { tokenHash } from "./crypto";
import { findReconnectTarget } from "./oauth-connection";
import { database } from "./runtime";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://mayi:mayi@localhost:55432/mayi";
process.env.DATABASE_URL = DATABASE_URL;

const ids = {
  workspace: createId(),
  otherWorkspace: createId(),
  user: createId(),
  client: createId(),
  otherClient: createId(),
};
const REDIRECT_URI = "https://client.example/callback";

const router = createRouter();
router.post("/api/oauth/token", oauthToken);
const app = createApp();
app.use(router);
const handle = toWebHandler(app);

function refresh(token: string, clientId = ids.client, formEncoded = false): Promise<Response> {
  const input = { grant_type: "refresh_token", refresh_token: token, client_id: clientId };
  return handle(new Request("http://mayi.test/api/oauth/token", {
    method: "POST",
    headers: { "content-type": formEncoded ? "application/x-www-form-urlencoded" : "application/json" },
    body: formEncoded ? new URLSearchParams(input) : JSON.stringify(input),
  }));
}

async function authorize(options: { agentId?: string; label?: string } = {}) {
  const code = `oauth-code-${createId()}`;
  const verifier = `oauth-verifier-${createId()}`;
  const challenge = Buffer.from(await sha256(verifier), "hex").toString("base64url");
  await database().sql`
    insert into oauth_codes (
      code_hash, workspace_id, user_id, client_id, redirect_uri, code_challenge, scopes, agent_id, label, expires_at
    ) values (
      ${await tokenHash(code)}, ${ids.workspace}, ${ids.user}, ${ids.client}, ${REDIRECT_URI},
      ${challenge}, ${["approval:read", "approval:create"]}, ${options.agentId ?? null}, ${options.label ?? null}, now() + interval '5 minutes'
    )
  `;
  return () => handle(new Request("http://mayi.test/api/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: ids.client, redirect_uri: REDIRECT_URI }),
  }));
}

type TokenBody = { access_token: string; refresh_token: string; agent_id: string };

async function seedConnection(label: string) {
  const agentId = createId();
  const refreshId = createId();
  const familyId = createId();
  const refreshToken = `mayi_refresh_test_${createId()}`;
  await database().sql`
    insert into agents (id, workspace_id, name, client_id, scopes, credential_hash, credential_expires_at, created_by)
    values (${agentId}, ${ids.workspace}, ${label}, ${ids.client}, ${["approval:read"]}, ${await tokenHash(`access-${label}`)}, now() + interval '1 hour', ${ids.user})
  `;
  await database().sql`
    insert into refresh_tokens (id, agent_id, family_id, token_hash, expires_at)
    values (${refreshId}, ${agentId}, ${familyId}, ${await tokenHash(refreshToken)}, now() + interval '30 days')
  `;
  return { agentId, familyId, refreshToken };
}

describe.sequential("OAuth refresh-token rotation", () => {
  beforeAll(async () => {
    await database().sql`
      insert into users (id, email, display_name, password_hash)
      values (${ids.user}, ${`${ids.user}@example.test`}, 'Refresh test', 'unused')
    `;
    await database().sql`insert into workspaces (id, name) values (${ids.workspace}, 'Refresh test')`;
    await database().sql`insert into workspaces (id, name) values (${ids.otherWorkspace}, 'Other workspace')`;
    await database().sql`
      insert into oauth_clients (id, name, redirect_uris, approval_callback_uris, registration_ip_hash)
      values (${ids.otherClient}, 'Other client', ${[REDIRECT_URI]}, ${["https://client.example/approval"]}, ${"e".repeat(64)})
    `;
    await database().sql`
      insert into memberships (workspace_id, user_id, role) values (${ids.workspace}, ${ids.user}, 'OWNER')
    `;
    await database().sql`
      insert into oauth_clients (id, name, redirect_uris, approval_callback_uris, registration_ip_hash)
      values (${ids.client}, 'Refresh test', ${["https://client.example/callback"]}, ${["https://client.example/approval"]}, ${"f".repeat(64)})
    `;
  });

  afterAll(async () => {
    await database().sql`delete from workspaces where id in ${database().sql([ids.workspace, ids.otherWorkspace])}`;
    await database().sql`delete from oauth_clients where id in ${database().sql([ids.client, ids.otherClient])}`;
    await database().sql`delete from users where id = ${ids.user}`;
    await database().close();
  });

  it("commits family and agent revocation before rejecting reuse", async () => {
    const connection = await seedConnection("sequential reuse");
    const rotated = await refresh(connection.refreshToken);
    expect(rotated.status).toBe(200);
    const token = await rotated.json() as { access_token: string; refresh_token: string };
    expect(token.access_token).toMatch(/^mayi_/);
    expect(token.refresh_token).toMatch(/^mayi_refresh_/);

    const reused = await refresh(connection.refreshToken);
    expect(reused.status).toBe(400);

    const [agent] = await database().sql`
      select revoked_at, credential_hash from agents where id = ${connection.agentId}
    `;
    expect(agent!.revoked_at).not.toBeNull();
    expect(agent!.credential_hash).toBeNull();
    const family = await database().sql`
      select revoked_at from refresh_tokens where family_id = ${connection.familyId}
    `;
    expect(family).toHaveLength(2);
    expect(family.every((row) => row.revoked_at !== null)).toBe(true);

    const newest = await refresh(token.refresh_token);
    expect(newest.status).toBe(400);
  });

  it("revokes the family when the same refresh token is used simultaneously", async () => {
    const connection = await seedConnection("concurrent reuse");
    const responses = await Promise.all([
      refresh(connection.refreshToken),
      refresh(connection.refreshToken),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 400]);
    const [agent] = await database().sql`
      select revoked_at, credential_hash from agents where id = ${connection.agentId}
    `;
    expect(agent).toMatchObject({ credential_hash: null });
    expect(agent!.revoked_at).not.toBeNull();
    const family = await database().sql`
      select revoked_at from refresh_tokens where family_id = ${connection.familyId}
    `;
    expect(family).toHaveLength(2);
    expect(family.every((row) => row.revoked_at !== null)).toBe(true);
  });

  it("does not rotate a token belonging to an owner-revoked agent", async () => {
    const connection = await seedConnection("revoked agent");
    await database().sql`update agents set revoked_at = now(), credential_hash = null where id = ${connection.agentId}`;
    expect((await refresh(connection.refreshToken)).status).toBe(400);
    const family = await database().sql`
      select revoked_at from refresh_tokens where family_id = ${connection.familyId}
    `;
    expect(family).toHaveLength(1);
    expect(family[0]!.revoked_at).not.toBeNull();
  });

  it("accepts the OAuth-standard form encoding without removing JSON compatibility", async () => {
    const connection = await seedConnection("form encoded");
    const response = await refresh(connection.refreshToken, ids.client, true);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      token_type: "Bearer",
      expires_in: 3_600,
    });
  });

  it("serializes simultaneous authorization-code exchange without a 500", async () => {
    const code = `oauth-code-${createId()}`;
    const verifier = `oauth-verifier-${createId()}`;
    const challenge = Buffer.from(await sha256(verifier), "hex").toString("base64url");
    const redirectUri = "https://client.example/callback";
    await database().sql`
      insert into oauth_codes (
        code_hash, workspace_id, user_id, client_id, redirect_uri, code_challenge, scopes, expires_at
      ) values (
        ${await tokenHash(code)}, ${ids.workspace}, ${ids.user}, ${ids.client}, ${redirectUri},
        ${challenge}, ${["approval:read"]}, now() + interval '5 minutes'
      )
    `;
    const exchange = () => handle(new Request("http://mayi.test/api/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        client_id: ids.client,
        redirect_uri: redirectUri,
      }),
    }));
    const responses = await Promise.all([exchange(), exchange()]);
    expect(responses.map(({ status }) => status).sort()).toEqual([200, 400]);
  });

  it("names a new connection after its label and reports the agent id", async () => {
    const response = await (await authorize({ label: "HARNESST — ledger-a" }))();
    expect(response.status).toBe(200);
    const token = await response.json() as TokenBody;
    const [agent] = await database().sql`select name, client_id from agents where id = ${token.agent_id}`;
    expect(agent).toMatchObject({ name: "HARNESST — ledger-a", client_id: ids.client });
  });

  it("reconnects onto the same agent, retiring its old credentials", async () => {
    const connection = await seedConnection("reconnect");
    const response = await (await authorize({ agentId: connection.agentId }))();
    expect(response.status).toBe(200);
    const token = await response.json() as TokenBody;
    expect(token.agent_id).toBe(connection.agentId);

    const [agent] = await database().sql`select name, scopes, credential_hash from agents where id = ${connection.agentId}`;
    expect(agent!.name).toBe("reconnect");
    expect(agent!.scopes).toEqual(["approval:read", "approval:create"]);
    expect(agent!.credential_hash).toBe(await tokenHash(token.access_token));

    // The pre-reconnect refresh token is dead, but using it must not be treated as
    // reuse: that would revoke the connection the user just renewed.
    expect((await refresh(connection.refreshToken)).status).toBe(400);
    const rotated = await refresh(token.refresh_token);
    expect(rotated.status).toBe(200);
    expect((await rotated.json() as TokenBody).agent_id).toBe(connection.agentId);
  });

  it("renames the connection when a reconnect carries a new label", async () => {
    const connection = await seedConnection("old name");
    expect((await (await authorize({ agentId: connection.agentId, label: "new name" }))()).status).toBe(200);
    const [agent] = await database().sql`select name from agents where id = ${connection.agentId}`;
    expect(agent!.name).toBe("new name");
  });

  it("revives a connection that refresh-token reuse revoked", async () => {
    const connection = await seedConnection("reuse then reconnect");
    await refresh(connection.refreshToken);
    expect((await refresh(connection.refreshToken)).status).toBe(400);

    const response = await (await authorize({ agentId: connection.agentId }))();
    expect(response.status).toBe(200);
    const [agent] = await database().sql`select revoked_at from agents where id = ${connection.agentId}`;
    expect(agent!.revoked_at).toBeNull();
  });

  it("refuses to reconnect a connection an owner revoked after consent", async () => {
    const connection = await seedConnection("owner revoked");
    const exchange = await authorize({ agentId: connection.agentId });
    await database().sql`update agents set revoked_at = now(), revoked_by = ${ids.user}, credential_hash = null where id = ${connection.agentId}`;
    expect((await exchange()).status).toBe(400);
    const [agent] = await database().sql`select revoked_at, credential_hash from agents where id = ${connection.agentId}`;
    expect(agent!.revoked_at).not.toBeNull();
    expect(agent!.credential_hash).toBeNull();
  });

  it("only offers a reconnect target to its own client and workspace", async () => {
    const connection = await seedConnection("scoped target");
    const lookup = (clientId: string, workspaceId: string) =>
      findReconnectTarget(database().sql, { agentId: connection.agentId, clientId, workspaceId });
    await expect(lookup(ids.client, ids.workspace)).resolves.toMatchObject({ status: "ok", agentId: connection.agentId });
    await expect(lookup(ids.otherClient, ids.workspace)).resolves.toEqual({ status: "not_found" });
    await expect(lookup(ids.client, ids.otherWorkspace)).resolves.toEqual({ status: "not_found" });
    await database().sql`update agents set revoked_at = now(), revoked_by = ${ids.user} where id = ${connection.agentId}`;
    await expect(lookup(ids.client, ids.workspace)).resolves.toEqual({ status: "owner_revoked" });
  });

  it("rejects an oversized chunked token request before token work", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(32 * 1024));
        controller.enqueue(new Uint8Array([1]));
        controller.close();
      },
    });
    const response = await handle(new Request("http://mayi.test/api/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: body as unknown as BodyInit,
      duplex: "half",
    } as RequestInit & { duplex: "half" }));
    expect(response.status).toBe(413);
  });

  it.each([null, [], { grant_type: 42 }])("maps malformed JSON shapes to an OAuth client error", async (body) => {
    const response = await handle(new Request("http://mayi.test/api/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }));
    expect(response.status).toBe(400);
  });
});
