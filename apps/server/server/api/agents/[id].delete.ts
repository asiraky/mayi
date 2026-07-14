import { createError, defineEventHandler, getRouterParam } from "h3";
import { audit, requireUser } from "../../utils/auth";
import { database } from "../../utils/runtime";

export default defineEventHandler(async (event) => {
  const auth = await requireUser(event);
  if (auth.role !== "OWNER") throw createError({ statusCode: 403, statusMessage: "Owner access required" });
  const id = getRouterParam(event, "id")!;
  const rows = await database().sql`update agents set revoked_at = now() where id = ${id} and workspace_id = ${auth.workspaceId} and revoked_at is null returning id`;
  if (!rows.length) throw createError({ statusCode: 404, statusMessage: "Agent not found" });
  await audit({ workspaceId: auth.workspaceId, actorType: "user", actorId: auth.userId, eventType: "agent.revoked", subjectType: "agent", subjectId: id });
  return { ok: true };
});
