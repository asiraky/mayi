import { defineEventHandler } from "h3";
import { requireUser } from "../../utils/auth";
import { database } from "../../utils/runtime";

export default defineEventHandler(async (event) => {
  const auth = await requireUser(event);
  const rows = await database().sql`select id, name, scopes, last_used_at, revoked_at from agents where workspace_id = ${auth.workspaceId} order by created_at desc`;
  return rows.map((row) => ({ id: String(row.id), name: row.name, scopes: row.scopes, lastUsedAt: row.last_used_at, revokedAt: row.revoked_at }));
});
