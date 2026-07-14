import { defineEventHandler } from "h3";
import { requireUser } from "../utils/auth";
import { database } from "../utils/runtime";

export default defineEventHandler(async (event) => {
  const auth = await requireUser(event);
  const rows = await database().sql`
    select id, actor_type, actor_id, event_type, subject_type, subject_id, metadata, created_at
    from audit_events where workspace_id = ${auth.workspaceId} order by created_at desc limit 200
  `;
  return rows.map((row) => ({ id: row.id, actorType: row.actor_type, actorId: row.actor_id, eventType: row.event_type, subjectType: row.subject_type, subjectId: row.subject_id, metadata: row.metadata, createdAt: row.created_at }));
});
