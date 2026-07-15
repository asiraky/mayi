import { canonicalDigest, createId, CreateApproval } from "@mayi/contracts";
import { isHighRisk, validateActionForEnforcement, validateSuggestedApprover } from "@mayi/domain";
import { createError, defineEventHandler } from "h3";
import { audit, requireAgent } from "../../utils/auth";
import { asHttpError, bodyAs, requireIdempotencyKey } from "../../utils/http";
import { database } from "../../utils/runtime";
import { serializeApproval } from "../../utils/serialize";

const OPERATION = "approval.draft";

export default defineEventHandler(async (event) => {
  const auth = await requireAgent(event, "approval:create");
  const input = await bodyAs(event, CreateApproval);
  try { validateActionForEnforcement(input.action, input.enforcement); } catch (error) { asHttpError(error); }
  const key = requireIdempotencyKey(event);
  const payloadHash = await canonicalDigest(input);
  const approvalId = await database().sql.begin(async (sql) => {
    const lockKey = `${auth.workspaceId}:${auth.agentId}:${OPERATION}:${key}`;
    await sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
    const previous = await sql`
      select payload_hash, response from idempotency_keys
      where workspace_id = ${auth.workspaceId} and credential_id = ${auth.agentId} and operation = ${OPERATION} and key = ${key}
      for update
    `;
    if (previous[0]) {
      if (previous[0].payload_hash !== payloadHash) throw createError({ statusCode: 409, statusMessage: "Idempotency key was reused with different content" });
      return String((previous[0].response as { id: string }).id);
    }
    const eligible = await sql`
      select m.user_id from memberships m join users u on u.id = m.user_id and u.active and u.deleted_at is null
      where m.workspace_id = ${auth.workspaceId} and m.active and m.revoked_at is null and m.role in ('OWNER', 'APPROVER')
    `;
    validateSuggestedApprover(input.suggestedApproverId, eligible.map((row) => String(row.user_id)));
    const id = createId();
    const [approval] = await sql`
      insert into approvals (id, workspace_id, agent_id, action, explanation, enforcement, high_risk, expires_at)
      values (${id}, ${auth.workspaceId}, ${auth.agentId}, ${JSON.stringify(input.action)}::jsonb, ${input.explanation}, ${input.enforcement}, ${isHighRisk(input.action)}, now() + make_interval(secs => ${input.expiresInSeconds}))
      returning id
    `;
    const storedId = String(approval!.id);
    await sql`
      insert into idempotency_keys (workspace_id, credential_id, operation, key, payload_hash, response, expires_at)
      values (${auth.workspaceId}, ${auth.agentId}, ${OPERATION}, ${key}, ${payloadHash}, ${JSON.stringify({ id: storedId })}::jsonb, now() + interval '24 hours')
    `;
    await audit({ workspaceId: auth.workspaceId, actorType: "agent", actorId: auth.agentId, eventType: "approval.drafted", subjectType: "approval", subjectId: storedId }, sql);
    return storedId;
  });
  return await serializeApproval(auth.workspaceId, approvalId);
});
