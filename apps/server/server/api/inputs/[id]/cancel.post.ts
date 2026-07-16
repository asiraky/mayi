import { createError, defineEventHandler, getRouterParam } from "h3";
import { audit, requireAgent } from "../../../utils/auth";
import { database } from "../../../utils/runtime";
import { serializeInput } from "../../../utils/serialize";
import { activateInputCallback } from "../../../utils/callback-outbox";

export default defineEventHandler(async (event) => {
  const auth = await requireAgent(event, "approval:cancel");
  const id = getRouterParam(event, "id")!;
  await database().sql.begin(async (sql) => {
    const rows = await sql`
      select id from inputs where id = ${id} and workspace_id = ${auth.workspaceId}
        and agent_id = ${auth.agentId} and state = 'PENDING' for update
    `;
    if (!rows.length) throw createError({ statusCode: 409, statusMessage: "Input cannot be cancelled" });
    await sql`
      update inputs set state = 'CANCELLED', cancelled_at = now()
      where id = ${id}
    `;
    await activateInputCallback(sql, id);
    await audit({ workspaceId: auth.workspaceId, actorType: "agent", actorId: auth.agentId, eventType: "input.cancelled", subjectType: "input", subjectId: id }, sql);
  });
  return await serializeInput(auth.workspaceId, id);
});
