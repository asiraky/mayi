import { actionAudience, Action, createId, Decision } from "@mayi/contracts";
import { requireRecentAuthentication } from "@mayi/domain";
import { signReceipt } from "@mayi/receipts";
import { createError, defineEventHandler, getRouterParam } from "h3";
import { audit, requireUser } from "../../../utils/auth";
import { getConfig } from "../../../utils/config";
import { bodyAs, asHttpError } from "../../../utils/http";
import { database } from "../../../utils/runtime";
import { serializeApproval } from "../../../utils/serialize";
import { signingKeys } from "../../../utils/signer";
import { activateApprovalCallback } from "../../../utils/callback-outbox";

export default defineEventHandler(async (event) => {
  const auth = await requireUser(event);
  const approvalId = getRouterParam(event, "id")!;
  const input = await bodyAs(event, Decision);
  try {
    await database().sql.begin("isolation level serializable", async (sql) => {
      const [approval] = await sql`
        select a.*, now() as database_now from approvals a
        where a.id = ${approvalId} and a.workspace_id = ${auth.workspaceId} for update
      `;
      if (!approval) throw createError({ statusCode: 404, statusMessage: "Approval not found" });
      if (approval.state !== "PENDING") throw createError({ statusCode: 409, statusMessage: `Approval is ${String(approval.state).toLowerCase()}` });
      const now = new Date(approval.database_now as Date | string);
      const expiresAt = new Date(approval.expires_at as Date | string);
      if (expiresAt.getTime() <= now.getTime()) {
        await sql`update approvals set state = 'EXPIRED', decided_at = now() where id = ${approvalId} and state = 'PENDING'`;
        await activateApprovalCallback(sql, approvalId);
        await audit({ workspaceId: auth.workspaceId, actorType: "system", eventType: "approval.expired", subjectType: "approval", subjectId: approvalId }, sql);
        return;
      }
      const eligible = await sql`
        select 1 from eligible_approvers e
        join memberships m on m.workspace_id = e.workspace_id and m.user_id = e.user_id and m.active and m.revoked_at is null
        join users u on u.id = e.user_id and u.active and u.deleted_at is null
        where e.approval_id = ${approvalId} and e.workspace_id = ${auth.workspaceId} and e.user_id = ${auth.userId}
      `;
      if (!eligible.length) throw createError({ statusCode: 403, statusMessage: "You are not currently eligible to decide this request" });
      if (approval.high_risk) requireRecentAuthentication(auth.recentAuthAt, now);
      await sql`
        update approvals set state = ${input.decision}, decided_at = now(), approver_id = ${auth.userId}, decision_comment = ${input.comment ?? null}
        where id = ${approvalId} and state = 'PENDING'
      `;
      if (input.decision === "APPROVED") {
        const id = createId();
        const action = Action.parse(approval.action);
        const audience = actionAudience(action) ?? getConfig().receiptAudience;
        const exp = Math.min(Math.floor(expiresAt.getTime() / 1000), Math.floor(now.getTime() / 1000) + 900);
        const keys = await signingKeys();
        const token = await signReceipt({
          iss: getConfig().receiptIssuer, aud: audience, sub: approvalId, jti: id,
          iat: Math.floor(now.getTime() / 1000), exp,
          workspace_id: auth.workspaceId, agent_id: String(approval.agent_id), policy_version: Number(approval.policy_version),
          action_digest: String(approval.action_digest), artefact_manifest_digest: String(approval.manifest_digest),
          approver_id: auth.userId, enforcement: approval.enforcement,
        }, keys.privateJwk, keys.kid);
        await sql`
          insert into receipts (id, approval_id, workspace_id, audience, compact_jws, expires_at)
          values (${id}, ${approvalId}, ${auth.workspaceId}, ${audience}, ${token}, to_timestamp(${exp}))
        `;
      }
      await activateApprovalCallback(sql, approvalId);
      await audit({ workspaceId: auth.workspaceId, actorType: "user", actorId: auth.userId, eventType: `approval.${input.decision.toLowerCase()}`, subjectType: "approval", subjectId: approvalId }, sql);
    });
  } catch (error) { asHttpError(error); }
  return await serializeApproval(auth.workspaceId, approvalId);
});
