import { defineEventHandler, getQuery } from "h3";
import { ApprovalState } from "@mayi/contracts";
import { requireUserOrAgent } from "../../utils/auth";
import { database } from "../../utils/runtime";
import { serializeApproval } from "../../utils/serialize";

export default defineEventHandler(async (event) => {
  const auth = await requireUserOrAgent(event);
  const parsedState = ApprovalState.safeParse(getQuery(event).state);
  const state = parsedState.success ? parsedState.data : null;
  const rows = await database().sql`
    select id from approvals where workspace_id = ${auth.workspaceId}
      and (${state}::approval_state is null or state = ${state}::approval_state)
      and (${auth.kind === "user"} or agent_id = ${auth.kind === "agent" ? auth.agentId : null}::mayi_id)
    order by created_at desc limit 100
  `;
  return Promise.all(rows.map((row) => serializeApproval(auth.workspaceId, String(row.id))));
});
