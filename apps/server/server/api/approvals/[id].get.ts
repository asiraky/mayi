import { createError, defineEventHandler, getRouterParam } from "h3";
import { requireUserOrAgent } from "../../utils/auth";
import { database } from "../../utils/runtime";
import { serializeApproval } from "../../utils/serialize";

export default defineEventHandler(async (event) => {
  const auth = await requireUserOrAgent(event);
  const id = getRouterParam(event, "id")!;
  if (auth.kind === "agent") {
    const own = await database().sql`select 1 from approvals where id = ${id} and workspace_id = ${auth.workspaceId} and agent_id = ${auth.agentId}`;
    if (!own.length) throw createError({ statusCode: 404, statusMessage: "Approval not found" });
  }
  const value = await serializeApproval(auth.workspaceId, id);
  if (!value) throw createError({ statusCode: 404, statusMessage: "Approval not found" });
  return value;
});
