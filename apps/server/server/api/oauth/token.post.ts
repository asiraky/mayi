import { createError, defineEventHandler } from "h3";
import { createId, sha256 } from "@mayi/contracts";
import { z } from "zod";
import { audit } from "../../utils/auth";
import { findReconnectTarget } from "../../utils/oauth-connection";
import { database } from "../../utils/runtime";
import { randomToken, tokenHash } from "../../utils/crypto";
import { readBoundedJsonOrFormBody } from "../../utils/http";

function base64urlHex(hex: string): string { return Buffer.from(hex, "hex").toString("base64url"); }

const TokenRequest = z.object({
  grant_type: z.string(),
  code: z.string().optional(),
  code_verifier: z.string().optional(),
  client_id: z.string().optional(),
  redirect_uri: z.string().optional(),
  refresh_token: z.string().optional(),
});

export default defineEventHandler(async (event) => {
  const parsed = TokenRequest.safeParse(await readBoundedJsonOrFormBody(event, 32 * 1024));
  if (!parsed.success) throw createError({ statusCode: 400, statusMessage: "Invalid token request" });
  const body = parsed.data;
  if (body.grant_type === "authorization_code") {
    const hash = await tokenHash(body.code ?? "");
    return database().sql.begin(async (sql) => {
      const rows = await sql`select * from oauth_codes where code_hash = ${hash} for update`;
      const code = rows[0];
      if (!code || code.consumed_at || new Date(code.expires_at as Date) <= new Date() || code.client_id !== body.client_id || code.redirect_uri !== body.redirect_uri) {
        throw createError({ statusCode: 400, statusMessage: "Invalid authorization code" });
      }
      if (base64urlHex(await sha256(body.code_verifier ?? "")) !== code.code_challenge) throw createError({ statusCode: 400, statusMessage: "PKCE verification failed" });
      await sql`update oauth_codes set consumed_at = now() where code_hash = ${hash}`;
      const access = `mayi_${randomToken()}`;
      const refresh = `mayi_refresh_${randomToken()}`;
      const refreshId = createId();
      const familyId = createId();
      let agentId: string;
      if (code.agent_id) {
        // Reconnect: renew credentials on the existing agent so its approvals, inputs and
        // idempotency keys stay reachable. Refresh rows are locked before the agent, the
        // same order the refresh grant takes them, so the two cannot deadlock.
        agentId = String(code.agent_id);
        await sql`select id from refresh_tokens where agent_id = ${agentId} for update`;
        const target = await findReconnectTarget(sql, { agentId, clientId: body.client_id!, workspaceId: String(code.workspace_id), lock: true });
        // The owner may have revoked the connection between consent and exchange.
        if (target.status !== "ok") throw createError({ statusCode: 400, statusMessage: "Connection can no longer be reconnected" });
        await sql`update refresh_tokens set revoked_at = now() where agent_id = ${agentId} and revoked_at is null`;
        await sql`
          update agents set name = coalesce(${code.label}, name), scopes = ${code.scopes}, credential_hash = ${await tokenHash(access)},
            credential_expires_at = now() + interval '1 hour', revoked_at = null
          where id = ${agentId}
        `;
        await audit({ workspaceId: String(code.workspace_id), actorType: "user", actorId: String(code.user_id), eventType: "agent.reconnected", subjectType: "agent", subjectId: agentId, metadata: { scopes: code.scopes } }, sql);
      } else {
        const [client] = await sql`select name from oauth_clients where id = ${body.client_id!}`;
        agentId = createId();
        await sql`
          insert into agents (id, workspace_id, name, client_id, scopes, credential_hash, credential_expires_at, created_by)
          values (${agentId}, ${code.workspace_id}, ${code.label ?? client?.name ?? "MCP client"}, ${body.client_id!}, ${code.scopes}, ${await tokenHash(access)}, now() + interval '1 hour', ${code.user_id})
        `;
      }
      await sql`
        insert into refresh_tokens (id, agent_id, family_id, token_hash, expires_at) values (${refreshId}, ${agentId}, ${familyId}, ${await tokenHash(refresh)}, now() + interval '30 days')
      `;
      return { access_token: access, token_type: "Bearer", expires_in: 3600, refresh_token: refresh, scope: (code.scopes as string[]).join(" "), agent_id: agentId };
    });
  }
  if (body.grant_type === "refresh_token") {
    const result = await database().sql.begin(async (sql) => {
      const rows = await sql`
        select r.*, a.scopes, a.client_id, a.revoked_at as agent_revoked_at
        from refresh_tokens r join agents a on a.id = r.agent_id
        where r.token_hash = ${await tokenHash(body.refresh_token ?? "")}
        for update of r, a
      `;
      const old = rows[0];
      if (!old || old.revoked_at || new Date(old.expires_at as Date) <= new Date()) {
        return { invalid: true as const };
      }
      if (old?.used_at) {
        await sql`update refresh_tokens set revoked_at = now() where family_id = ${old.family_id} and revoked_at is null`;
        await sql`update agents set revoked_at = now(), credential_hash = null where id = ${old.agent_id} and revoked_at is null`;
        return { reuseDetected: true as const };
      }
      if (old.agent_revoked_at || old.client_id !== body.client_id) {
        await sql`update refresh_tokens set revoked_at = now() where family_id = ${old.family_id} and revoked_at is null`;
        return { invalid: true as const };
      }
      const access = `mayi_${randomToken()}`;
      const refresh = `mayi_refresh_${randomToken()}`;
      const refreshId = createId();
      await sql`update refresh_tokens set used_at = now() where id = ${old.id}`;
      const updated = await sql`
        update agents set credential_hash = ${await tokenHash(access)}, credential_expires_at = now() + interval '1 hour'
        where id = ${old.agent_id} and revoked_at is null
        returning id
      `;
      if (updated.length !== 1) {
        await sql`update refresh_tokens set revoked_at = now() where family_id = ${old.family_id} and revoked_at is null`;
        return { invalid: true as const };
      }
      await sql`insert into refresh_tokens (id, agent_id, family_id, token_hash, expires_at) values (${refreshId}, ${old.agent_id}, ${old.family_id}, ${await tokenHash(refresh)}, now() + interval '30 days')`;
      return {
        reuseDetected: false as const,
        token: { access_token: access, token_type: "Bearer", expires_in: 3600, refresh_token: refresh, scope: (old.scopes as string[]).join(" "), agent_id: String(old.agent_id) },
      };
    });
    if ("reuseDetected" in result && result.reuseDetected) {
      throw createError({ statusCode: 400, statusMessage: "Refresh token reuse detected; connection revoked" });
    }
    if ("invalid" in result) throw createError({ statusCode: 400, statusMessage: "Invalid refresh token" });
    return result.token;
  }
  throw createError({ statusCode: 400, statusMessage: "Unsupported grant type" });
});
