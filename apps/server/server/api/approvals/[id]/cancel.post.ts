import { createError, defineEventHandler, getRouterParam } from "h3";
import { audit, requireAgent } from "../../../utils/auth";
import { database } from "../../../utils/runtime";
import { serializeApproval } from "../../../utils/serialize";

export default defineEventHandler(async (event) => {
  const auth = await requireAgent(event, "approval:cancel");
  const id = getRouterParam(event, "id")!;
  const rows = await database().sql`
    update approvals set state = 'CANCELLED', cancelled_at = now(), decided_at = now()
    where id = ${id} and workspace_id = ${auth.workspaceId} and agent_id = ${auth.agentId} and state in ('DRAFT', 'PENDING') returning id
  `;
  if (!rows.length) throw createError({ statusCode: 409, statusMessage: "Approval cannot be cancelled" });
  await audit({ workspaceId: auth.workspaceId, actorType: "agent", actorId: auth.agentId, eventType: "approval.cancelled", subjectType: "approval", subjectId: id });
  return await serializeApproval(auth.workspaceId, id);
});
