import { createError, deleteCookie, getCookie, getHeader, setCookie, type H3Event } from "h3";
import { createId } from "@mayi/contracts";
import type { DatabaseSql } from "@mayi/db";
import { database } from "./runtime";
import { getConfig } from "./config";
import { randomToken, tokenHash } from "./crypto";

export type UserAuth = {
  kind: "user";
  userId: string;
  workspaceId: string;
  sessionId: string;
  recentAuthAt: Date;
  role: "OWNER" | "APPROVER" | "MEMBER";
};
export type AgentAuth = { kind: "agent"; agentId: string; workspaceId: string; clientId: string | null; scopes: string[] };

export async function createSession(event: H3Event, userId: string): Promise<string> {
  const sessionId = createId();
  const token = `mayi_session_${randomToken()}`;
  const hash = await tokenHash(token);
  await database().sql`
    insert into sessions (id, user_id, token_hash, recent_auth_at, expires_at)
    values (${sessionId}, ${userId}, ${hash}, now(), now() + interval '30 days') returning id
  `;
  setCookie(event, "mayi_session", token, {
    httpOnly: true, secure: getConfig().secureCookies, sameSite: "lax", path: "/", maxAge: 30 * 24 * 60 * 60,
  });
  return token;
}

export async function revokeSession(event: H3Event): Promise<void> {
  const token = getCookie(event, "mayi_session");
  if (token) await database().sql`update sessions set revoked_at = now() where token_hash = ${await tokenHash(token)} and revoked_at is null`;
  deleteCookie(event, "mayi_session", { path: "/" });
}

export async function requireUser(event: H3Event): Promise<UserAuth> {
  const bearer = getHeader(event, "authorization");
  const token = getCookie(event, "mayi_session") ?? (bearer?.startsWith("Bearer mayi_session_") ? bearer.slice(7) : undefined);
  if (!token) throw createError({ statusCode: 401, statusMessage: "Authentication required" });
  const workspaceHint = getHeader(event, "x-workspace-id");
  const hash = await tokenHash(token);
  const rows = await database().sql`
    select s.id as session_id, s.user_id, s.recent_auth_at, m.workspace_id, m.role
    from sessions s
    join users u on u.id = s.user_id and u.active and u.deleted_at is null
    join memberships m on m.user_id = u.id and m.active and m.revoked_at is null
    where s.token_hash = ${hash} and s.revoked_at is null and s.expires_at > now()
      and (${workspaceHint ?? null}::mayi_id is null or m.workspace_id = ${workspaceHint ?? null}::mayi_id)
    order by m.created_at asc limit 1
  `;
  const row = rows[0];
  if (!row) throw createError({ statusCode: 401, statusMessage: "Session is invalid or expired" });
  return {
    kind: "user", userId: String(row.user_id), workspaceId: String(row.workspace_id), sessionId: String(row.session_id),
    recentAuthAt: new Date(String(row.recent_auth_at)), role: row.role as UserAuth["role"],
  };
}

export async function requireAgent(event: H3Event, requiredScope?: string): Promise<AgentAuth> {
  const authorization = getHeader(event, "authorization");
  if (!authorization?.startsWith("Bearer ")) throw createError({ statusCode: 401, statusMessage: "Bearer token required" });
  const hash = await tokenHash(authorization.slice(7));
  const rows = await database().sql`
    update agents set last_used_at = now()
    where credential_hash = ${hash} and revoked_at is null and (credential_expires_at is null or credential_expires_at > now())
    returning id, workspace_id, client_id, scopes
  `;
  const row = rows[0];
  if (!row) throw createError({ statusCode: 401, statusMessage: "Agent token is invalid or revoked" });
  const scopes = row.scopes as string[];
  if (requiredScope && !scopes.includes(requiredScope)) throw createError({ statusCode: 403, statusMessage: `Missing scope: ${requiredScope}` });
  return {
    kind: "agent", agentId: String(row.id), workspaceId: String(row.workspace_id),
    clientId: row.client_id === null ? null : String(row.client_id), scopes,
  };
}

export async function requireUserOrAgent(event: H3Event): Promise<UserAuth | AgentAuth> {
  const authorization = getHeader(event, "authorization");
  return getCookie(event, "mayi_session") || authorization?.startsWith("Bearer mayi_session_") ? requireUser(event) : requireAgent(event, "approval:read");
}

export async function audit(input: {
  workspaceId: string; actorType: "user" | "agent" | "system"; actorId?: string;
  eventType: string; subjectType: string; subjectId: string; metadata?: Record<string, unknown>;
}, sql: DatabaseSql = database().sql): Promise<void> {
  const id = createId();
  await sql`
    insert into audit_events (id, workspace_id, actor_type, actor_id, event_type, subject_type, subject_id, metadata)
    values (${id}, ${input.workspaceId}, ${input.actorType}, ${input.actorId ?? null}, ${input.eventType}, ${input.subjectType}, ${input.subjectId}, ${JSON.stringify(input.metadata ?? {})}::jsonb)
  `;
}
