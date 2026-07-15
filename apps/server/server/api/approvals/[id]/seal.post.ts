import { actionName, Action, createId, SealApproval } from "@mayi/contracts";
import { freezeDigests } from "@mayi/domain";
import { createError, defineEventHandler, getRouterParam } from "h3";
import { audit, requireAgent } from "../../../utils/auth";
import { bodyAs } from "../../../utils/http";
import { database } from "../../../utils/runtime";
import { serializeApproval } from "../../../utils/serialize";

export default defineEventHandler(async (event) => {
  const auth = await requireAgent(event, "approval:create");
  const approvalId = getRouterParam(event, "id")!;
  const input = await bodyAs(event, SealApproval);
  if (new Set(input.artefactIds).size !== input.artefactIds.length) throw createError({ statusCode: 422, statusMessage: "Artefacts may only appear once" });
  await database().sql.begin("isolation level serializable", async (sql) => {
    const [approval] = await sql`
      select a.*, w.policy_version from approvals a join workspaces w on w.id = a.workspace_id
      where a.id = ${approvalId} and a.workspace_id = ${auth.workspaceId} and a.agent_id = ${auth.agentId} for update
    `;
    if (!approval) throw createError({ statusCode: 404, statusMessage: "Approval not found" });
    if (approval.state !== "DRAFT") throw createError({ statusCode: 409, statusMessage: "Approval is already sealed" });
    const age = await sql`select now() > ${approval.created_at}::timestamptz + interval '15 minutes' as old, now() >= ${approval.expires_at}::timestamptz as expired`;
    if (age[0]!.old || age[0]!.expired) throw createError({ statusCode: 409, statusMessage: "Draft is too old to seal; create a new request" });
    const files = input.artefactIds.length ? await sql`
      select id, filename, media_type, size, sha256 from artefacts
      where workspace_id = ${auth.workspaceId} and approval_id = ${approvalId} and id in ${sql(input.artefactIds)} and state = 'READY'
    ` : [];
    if (files.length !== input.artefactIds.length) throw createError({ statusCode: 422, statusMessage: "Every artefact must be ready and belong to this draft" });
    const byId = new Map(files.map((file) => [String(file.id), file]));
    const manifest = input.artefactIds.map((id, ordinal) => {
      const file = byId.get(id)!;
      return { id, ordinal, filename: String(file.filename), mediaType: file.media_type as "application/pdf", size: Number(file.size), sha256: String(file.sha256) };
    });
    const action = Action.parse(approval.action);
    const digests = await freezeDigests(action, manifest);
    const eligible = await sql`
      select m.user_id from memberships m join users u on u.id = m.user_id and u.active and u.deleted_at is null
      where m.workspace_id = ${auth.workspaceId} and m.active and m.revoked_at is null and m.role in ('OWNER', 'APPROVER')
    `;
    if (!eligible.length) throw createError({ statusCode: 409, statusMessage: "No eligible approver exists under current policy" });
    for (const item of manifest) await sql`insert into approval_artefacts (approval_id, artefact_id, ordinal) values (${approvalId}, ${item.id}, ${item.ordinal})`;
    for (const row of eligible) await sql`insert into eligible_approvers (approval_id, workspace_id, user_id) values (${approvalId}, ${auth.workspaceId}, ${row.user_id})`;
    await sql`
      update approvals set state = 'PENDING', action_digest = ${digests.actionDigest}, manifest_digest = ${digests.manifestDigest},
        policy_version = ${approval.policy_version}, sealed_at = now() where id = ${approvalId}
    `;
    await sql`
      insert into jobs (id, workspace_id, type, dedupe_key, payload)
      values (${createId()}, ${auth.workspaceId}, 'push.approval_pending', ${approvalId}, ${JSON.stringify({ approvalId })}::jsonb) on conflict do nothing
    `;
    const rules = await sql`
      select r.id, r.destination_id, d.type from forwarding_rules r join forwarding_destinations d on d.id = r.destination_id
      where r.workspace_id = ${auth.workspaceId} and r.active and d.active and d.verified_at is not null
        and (r.action_kind = '*' or r.action_kind = ${actionName(action)})
    `;
    for (const rule of rules) {
      const deliveries = await sql`
        insert into forwarding_deliveries (id, workspace_id, approval_id, destination_id, origin_id)
        values (${createId()}, ${auth.workspaceId}, ${approvalId}, ${rule.destination_id}, ${approvalId}) on conflict do nothing returning id
      `;
      if (deliveries[0]) await sql`
        insert into jobs (id, workspace_id, type, dedupe_key, payload) values
        (${createId()}, ${auth.workspaceId}, ${rule.type === "EMAIL" ? "email.approval_pending" : "webhook.approval_pending"}, ${`${approvalId}:${rule.destination_id}`}, ${JSON.stringify({ approvalId, destinationId: String(rule.destination_id), deliveryId: String(deliveries[0].id) })}::jsonb) on conflict do nothing
      `;
    }
    await audit({ workspaceId: auth.workspaceId, actorType: "agent", actorId: auth.agentId, eventType: "approval.sealed", subjectType: "approval", subjectId: approvalId, metadata: digests }, sql);
  });
  return await serializeApproval(auth.workspaceId, approvalId);
});
