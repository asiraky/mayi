import { Action } from "@mayi/contracts";
import { freezeDigests } from "@mayi/domain";
import { createError, defineEventHandler, getRouterParam } from "h3";
import { audit, requireAgent } from "../../../utils/auth";
import { database } from "../../../utils/runtime";
import { serializeApproval } from "../../../utils/serialize";
import { activateApprovalCallback } from "../../../utils/callback-outbox";

export default defineEventHandler(async (event) => {
  const auth = await requireAgent(event, "approval:cancel");
  const id = getRouterParam(event, "id")!;
  await database().sql.begin(async (sql) => {
    const rows = await sql`
      select id, state, action from approvals where id = ${id} and workspace_id = ${auth.workspaceId}
        and agent_id = ${auth.agentId} and state in ('DRAFT', 'PENDING') for update
    `;
    if (!rows.length) throw createError({ statusCode: 409, statusMessage: "Approval cannot be cancelled" });
    if (rows[0]!.state === "DRAFT") {
      const digests = await freezeDigests(Action.parse(rows[0]!.action), []);
      await sql`
        update approvals set state = 'CANCELLED', cancelled_at = now(), decided_at = now(),
          action_digest = ${digests.actionDigest}, manifest_digest = ${digests.manifestDigest}, sealed_at = now()
        where id = ${id}
      `;
    } else {
      await sql`
        update approvals set state = 'CANCELLED', cancelled_at = now(), decided_at = now()
        where id = ${id}
      `;
    }
    await sql`
      update artefacts set state = 'DELETING'
      where workspace_id = ${auth.workspaceId} and approval_id = ${id}
        and state = 'READY'
        and not exists (select 1 from approval_artefacts aa where aa.artefact_id = artefacts.id)
    `;
    await activateApprovalCallback(sql, id);
    await audit({ workspaceId: auth.workspaceId, actorType: "agent", actorId: auth.agentId, eventType: "approval.cancelled", subjectType: "approval", subjectId: id }, sql);
  });
  return await serializeApproval(auth.workspaceId, id);
});
