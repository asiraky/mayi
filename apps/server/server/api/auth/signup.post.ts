import { createId, Signup } from "@mayi/contracts";
import { createError, defineEventHandler, getHeader } from "h3";
import { bodyAs } from "../../utils/http";
import { database } from "../../utils/runtime";
import { createSession, audit } from "../../utils/auth";
import { getConfig } from "../../utils/config";
import { passwordHash, timingSafeEqual } from "../../utils/crypto";
import { authenticationClientAddress, recordAuthenticationAttempt } from "../../utils/auth-rate-limit";

export default defineEventHandler(async (event) => {
  const input = await bodyAs(event, Signup);
  const source = authenticationClientAddress(event);
  await recordAuthenticationAttempt(`signup:${source}`, 10);
  const config = getConfig();
  const result = await database().sql.begin(async (sql) => {
    await sql`select pg_advisory_xact_lock(71924701)`;
    const counts = await sql`select count(*)::int as count from users`;
    if (Number(counts[0]!.count) === 0 && config.bootstrapSecret && (!input.bootstrapSecret || !timingSafeEqual(input.bootstrapSecret, config.bootstrapSecret))) {
      throw createError({ statusCode: 403, statusMessage: "Valid bootstrap secret required for first owner" });
    }
    const existing = await sql`select 1 from users where lower(email) = lower(${input.email})`;
    if (existing.length) throw createError({ statusCode: 409, statusMessage: "Email is already registered" });
    const userId = createId();
    const workspaceId = createId();
    const [user] = await sql`
      insert into users (id, email, display_name, password_hash) values (${userId}, ${input.email.toLowerCase()}, ${input.displayName}, ${await passwordHash(input.password)}) returning id
    `;
    const [workspace] = await sql`
      insert into workspaces (id, name, retention_days) values (${workspaceId}, ${`${input.displayName}'s workspace`}, ${config.retentionDays}) returning id, name
    `;
    await sql`insert into memberships (workspace_id, user_id, role) values (${workspace!.id}, ${user!.id}, 'OWNER')`;
    await audit({ workspaceId: String(workspace!.id), actorType: "user", actorId: String(user!.id), eventType: "workspace.created", subjectType: "workspace", subjectId: String(workspace!.id) }, sql);
    return { userId: String(user!.id), workspaceId: String(workspace!.id), workspaceName: String(workspace!.name) };
  });
  const sessionToken = await createSession(event, result.userId);
  return { user: { id: result.userId, email: input.email.toLowerCase(), displayName: input.displayName }, workspace: { id: result.workspaceId, name: result.workspaceName }, ...(getHeader(event, "x-mayi-native") === "true" ? { sessionToken } : {}) };
});
