import { createId, sha256 } from "@mayi/contracts";
import { createApp, createRouter, toWebHandler } from "h3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import oauthToken from "../api/oauth/token.post";
import { tokenHash } from "./crypto";
import { database } from "./runtime";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://mayi:mayi@localhost:55432/mayi";
process.env.DATABASE_URL = DATABASE_URL;

const ids = {
  workspace: createId(),
  user: createId(),
  client: createId(),
};

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
    await database().sql`
      insert into memberships (workspace_id, user_id, role) values (${ids.workspace}, ${ids.user}, 'OWNER')
    `;
    await database().sql`
      insert into oauth_clients (id, name, redirect_uris, approval_callback_uris, registration_ip_hash)
      values (${ids.client}, 'Refresh test', ${["https://client.example/callback"]}, ${["https://client.example/approval"]}, ${"f".repeat(64)})
    `;
  });

  afterAll(async () => {
    await database().sql`delete from workspaces where id = ${ids.workspace}`;
    await database().sql`delete from oauth_clients where id = ${ids.client}`;
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
