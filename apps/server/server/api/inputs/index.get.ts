import { defineEventHandler, getQuery } from "h3";
import { InputState } from "@mayi/contracts";
import { requireUserOrAgent } from "../../utils/auth";
import { database } from "../../utils/runtime";
import { serializeInput } from "../../utils/serialize";

export default defineEventHandler(async (event) => {
  const auth = await requireUserOrAgent(event);
  const parsedState = InputState.safeParse(getQuery(event).state);
  const state = parsedState.success ? parsedState.data : null;
  const rows = await database().sql`
    select id from inputs where workspace_id = ${auth.workspaceId}
      and (${state}::input_state is null or state = ${state}::input_state)
      and (${auth.kind === "user"} or agent_id = ${auth.kind === "agent" ? auth.agentId : null}::mayi_id)
    order by created_at desc limit 100
  `;
  return Promise.all(rows.map((row) => serializeInput(auth.workspaceId, String(row.id))));
});
