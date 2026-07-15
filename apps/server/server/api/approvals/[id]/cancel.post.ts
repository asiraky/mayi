import { createError, defineEventHandler, getRouterParam } from "h3";
import { audit, requireAgent } from "../../../utils/auth";
import { database } from "../../../utils/runtime";
import { serializeApproval } from "../../../utils/serialize";
import { activateApprovalCallback } from "../../../utils/callback-outbox";

export default defineEventHandler(async (event) => {
  const auth = await requireAgent(event, "approval:cancel");
  const id = getRouterParam(event, "id")!;
  await database().sql.begin("isolation level serializable", async (sql) => {
    const rows = await sql`
      select id from approvals where id = ${id} and workspace_id = ${auth.workspaceId}
        and agent_id = ${auth.agentId} and state in ('DRAFT', 'PENDING') for update
    `;
    if (!rows.length) throw createError({ statusCode: 409, statusMessage: "Approval cannot be cancelled" });
    await sql`
      update approvals set state = 'CANCELLED', cancelled_at = now(), decided_at = now()
      where id = ${id}
    `;
    await activateApprovalCallback(sql, id);
    await audit({ workspaceId: auth.workspaceId, actorType: "agent", actorId: auth.agentId, eventType: "approval.cancelled", subjectType: "approval", subjectId: id }, sql);
  });
  return await serializeApproval(auth.workspaceId, id);
});
