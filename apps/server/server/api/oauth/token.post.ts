import { createError, defineEventHandler, readBody } from "h3";
import { sha256 } from "@mayi/contracts";
import { database } from "../../utils/runtime";
import { randomToken, tokenHash } from "../../utils/crypto";

function base64urlHex(hex: string): string { return Buffer.from(hex, "hex").toString("base64url"); }

export default defineEventHandler(async (event) => {
  const body = await readBody<Record<string, string>>(event);
  if (body.grant_type === "authorization_code") {
    const hash = await tokenHash(body.code ?? "");
    return database().sql.begin("isolation level serializable", async (sql) => {
      const rows = await sql`select * from oauth_codes where code_hash = ${hash} for update`;
      const code = rows[0];
      if (!code || code.consumed_at || new Date(code.expires_at as Date) <= new Date() || code.client_id !== body.client_id || code.redirect_uri !== body.redirect_uri) {
        throw createError({ statusCode: 400, statusMessage: "Invalid authorization code" });
      }
      if (base64urlHex(await sha256(body.code_verifier ?? "")) !== code.code_challenge) throw createError({ statusCode: 400, statusMessage: "PKCE verification failed" });
      await sql`update oauth_codes set consumed_at = now() where code_hash = ${hash}`;
      const access = `mayi_${randomToken()}`;
      const refresh = `mayi_refresh_${randomToken()}`;
      const [client] = await sql`select name from oauth_clients where id = ${body.client_id!}`;
      const [agent] = await sql`
        insert into agents (workspace_id, name, client_id, scopes, credential_hash, credential_expires_at, created_by)
        values (${code.workspace_id}, ${client?.name ?? "MCP client"}, ${body.client_id!}, ${code.scopes}, ${await tokenHash(access)}, now() + interval '1 hour', ${code.user_id}) returning id
      `;
      await sql`
        insert into refresh_tokens (agent_id, family_id, token_hash, expires_at) values (${agent!.id}, ${crypto.randomUUID()}, ${await tokenHash(refresh)}, now() + interval '30 days')
      `;
      return { access_token: access, token_type: "Bearer", expires_in: 3600, refresh_token: refresh, scope: (code.scopes as string[]).join(" ") };
    });
  }
  if (body.grant_type === "refresh_token") {
    return database().sql.begin("isolation level serializable", async (sql) => {
      const rows = await sql`select r.*, a.scopes from refresh_tokens r join agents a on a.id = r.agent_id where r.token_hash = ${await tokenHash(body.refresh_token ?? "")} for update`;
      const old = rows[0];
      if (old?.used_at) {
        await sql`update refresh_tokens set revoked_at = now() where family_id = ${old.family_id} and revoked_at is null`;
        await sql`update agents set revoked_at = now(), credential_hash = null where id = ${old.agent_id} and revoked_at is null`;
        throw createError({ statusCode: 400, statusMessage: "Refresh token reuse detected; connection revoked" });
      }
      if (!old || old.revoked_at || new Date(old.expires_at as Date) <= new Date()) throw createError({ statusCode: 400, statusMessage: "Invalid refresh token" });
      const access = `mayi_${randomToken()}`;
      const refresh = `mayi_refresh_${randomToken()}`;
      await sql`update refresh_tokens set used_at = now() where id = ${old.id}`;
      await sql`update agents set credential_hash = ${await tokenHash(access)}, credential_expires_at = now() + interval '1 hour' where id = ${old.agent_id} and revoked_at is null`;
      await sql`insert into refresh_tokens (agent_id, family_id, token_hash, expires_at) values (${old.agent_id}, ${old.family_id}, ${await tokenHash(refresh)}, now() + interval '30 days')`;
      return { access_token: access, token_type: "Bearer", expires_in: 3600, refresh_token: refresh, scope: (old.scopes as string[]).join(" ") };
    });
  }
  throw createError({ statusCode: 400, statusMessage: "Unsupported grant type" });
});
