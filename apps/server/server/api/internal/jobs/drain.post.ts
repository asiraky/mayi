import { actionName, Action } from "@mayi/contracts";
import { defineEventHandler } from "h3";
import { database } from "../../../utils/runtime";
import { audit } from "../../../utils/auth";
import { signWebhook, validateOutboundUrl } from "../../../utils/forwarding";
import {
  CALLBACK_JOB_TYPE,
  activateApprovalCallback,
  claimNextJob,
  markCallbackDelivered,
  markCallbackFailed,
  sendApprovalCallback,
  type OutboxJob,
} from "../../../utils/callback-outbox";
import { requireCronSecret } from "../../../utils/internal-auth";
import { cleanupExpiredStagedArtefacts } from "../../../utils/staged-artefact-cleanup";

type Job = OutboxJob;

async function push(job: Job): Promise<void> {
  const approvalId = job.payload.approvalId;
  if (!approvalId) throw new Error("Missing approval ID");
  const devices = await database().sql`
    select distinct d.expo_push_token from devices d join eligible_approvers e on e.user_id = d.user_id and e.workspace_id = d.workspace_id
    where e.approval_id = ${approvalId} and d.workspace_id = ${job.workspace_id} and d.active
  `;
  if (!devices.length) return;
  const messages = devices.map((row) => ({ to: row.expo_push_token, title: "Approval requested", body: "Open May I? to review.", data: { approvalId }, sound: "default", channelId: "default" }));
  const response = await fetch("https://exp.host/--/api/v2/push/send", { method: "POST", headers: { "content-type": "application/json", ...(process.env.EXPO_ACCESS_TOKEN ? { authorization: `Bearer ${process.env.EXPO_ACCESS_TOKEN}` } : {}) }, body: JSON.stringify(messages) });
  if (!response.ok) throw new Error(`Expo push returned ${response.status}`);
}

async function webhook(job: Job): Promise<void> {
  const { approvalId, destinationId, deliveryId } = job.payload;
  if (!approvalId || !destinationId || !deliveryId) throw new Error("Incomplete webhook job");
  const rows = await database().sql`
    select d.endpoint, d.mode, r.include_action, r.include_artefact_metadata,
      a.action, a.action_digest, a.manifest_digest, a.policy_version, a.expires_at, fd.origin_id, fd.hop_count
    from forwarding_destinations d
    join forwarding_rules r on r.destination_id = d.id and r.workspace_id = d.workspace_id and r.active
    join approvals a on a.id = ${approvalId} and a.workspace_id = d.workspace_id
    join forwarding_deliveries fd on fd.id = ${deliveryId} and fd.destination_id = d.id and fd.approval_id = a.id
    where d.id = ${destinationId} and d.workspace_id = ${job.workspace_id} and d.active and d.verified_at is not null
      and (r.action_kind = '*' or r.action_kind = case
        when a.action->>'kind' = 'tool-call' then a.action->>'toolName'
        else a.action->>'kind'
      end) limit 1
  `;
  const row = rows[0]; if (!row) throw new Error("Forwarding authority no longer exists");
  const artefacts = row.include_artefact_metadata ? await database().sql`
    select aa.ordinal, f.filename, f.media_type, f.size, f.sha256 from approval_artefacts aa join artefacts f on f.id = aa.artefact_id
    where aa.approval_id = ${approvalId} order by aa.ordinal
  ` : [];
  const payload = {
    type: "mayi.approval_pending", version: 1, workspaceId: job.workspace_id, requestId: approvalId,
    destinationId, originId: String(row.origin_id), hopCount: Number(row.hop_count), policyVersion: Number(row.policy_version),
    actionDigest: String(row.action_digest), artefactManifestDigest: String(row.manifest_digest), expiresAt: new Date(row.expires_at as Date).toISOString(),
    ...(row.include_action ? { action: row.action } : {}), ...(row.include_artefact_metadata ? { artefacts } : {}),
  };
  const endpoint = await validateOutboundUrl(String(row.endpoint));
  const response = await fetch(endpoint, { method: "POST", redirect: "manual", headers: { "content-type": "application/json", "x-mayi-signature": await signWebhook(payload), "user-agent": "MayI-Webhook/1" }, body: JSON.stringify(payload) });
  if (!response.ok || response.status >= 300) throw new Error(`Webhook returned ${response.status}`);
  await database().sql`update forwarding_deliveries set state = 'DELIVERED', response_code = ${response.status}, delivered_at = now() where id = ${deliveryId} and workspace_id = ${job.workspace_id}`;
}

async function email(job: Job): Promise<void> {
  const { approvalId, destinationId, deliveryId } = job.payload;
  if (!approvalId || !destinationId || !deliveryId || !process.env.EMAIL_API_URL || !process.env.EMAIL_API_KEY) throw new Error("Email delivery is not configured");
  const rows = await database().sql`
    select d.endpoint, a.action, a.expires_at from forwarding_destinations d join approvals a on a.id = ${approvalId} and a.workspace_id = d.workspace_id
    where d.id = ${destinationId} and d.workspace_id = ${job.workspace_id} and d.type = 'EMAIL' and d.active and d.verified_at is not null
  `;
  const row = rows[0]; if (!row) throw new Error("Email destination no longer exists"); const action = Action.parse(row.action);
  const response = await fetch(process.env.EMAIL_API_URL, { method: "POST", headers: { authorization: `Bearer ${process.env.EMAIL_API_KEY}`, "content-type": "application/json" }, body: JSON.stringify({
    to: row.endpoint, subject: "May I? approval requested", text: `An agent requested approval for ${actionName(action)}. Review it securely: ${process.env.PUBLIC_ORIGIN}/?approval=${approvalId}\nExpires: ${new Date(row.expires_at as Date).toISOString()}`,
  }) });
  if (!response.ok) throw new Error(`Email provider returned ${response.status}`);
  await database().sql`update forwarding_deliveries set state = 'DELIVERED', response_code = ${response.status}, delivered_at = now() where id = ${deliveryId} and workspace_id = ${job.workspace_id}`;
}

export default defineEventHandler(async (event) => {
  requireCronSecret(event);
  const cleanedArtefacts = await cleanupExpiredStagedArtefacts();
  let expired = 0;
  for (; expired < 100; expired++) {
    const didExpire = await database().sql.begin(async (sql) => {
      const rows = await sql`
        select id, workspace_id from approvals
        where state = 'PENDING' and expires_at <= now()
        order by expires_at for update skip locked limit 1
      `;
      if (!rows[0]) return false;
      const approvalId = String(rows[0].id);
      const workspaceId = String(rows[0].workspace_id);
      await sql`update approvals set state = 'EXPIRED', decided_at = now() where id = ${approvalId} and state = 'PENDING'`;
      await activateApprovalCallback(sql, approvalId);
      await audit({ workspaceId, actorType: "system", eventType: "approval.expired", subjectType: "approval", subjectId: approvalId }, sql);
      return true;
    });
    if (!didExpire) break;
  }
  let processed = 0;
  for (; processed < 25; processed++) {
    const job = await claimNextJob(); if (!job) break;
    try {
      let completed = true;
      if (job.type === CALLBACK_JOB_TYPE) {
        await sendApprovalCallback(job);
        completed = await markCallbackDelivered(job);
      } else if (job.type === "push.approval_pending") await push(job);
      else if (job.type === "webhook.approval_pending") await webhook(job);
      else if (job.type === "email.approval_pending") await email(job);
      else throw new Error("Unknown job type");
      if (job.type !== CALLBACK_JOB_TYPE) {
        await database().sql`update jobs set state = 'SUCCEEDED', completed_at = now(), locked_at = null, lease_token = null, last_error = null where id = ${job.id}`;
      }
      if (completed) {
        await audit({ workspaceId: job.workspace_id, actorType: "system", eventType: "job.succeeded", subjectType: "job", subjectId: job.id, metadata: { type: job.type } });
      }
    } catch (error) {
      if (job.type === CALLBACK_JOB_TYPE) {
        await markCallbackFailed(job, error);
      } else {
        const message = error instanceof Error ? error.message.slice(0, 500) : "Job failed";
        if (job.attempts >= 10) {
          await database().sql`update jobs set state = 'DEAD_LETTER', locked_at = null, lease_token = null, completed_at = now(), last_error = ${message} where id = ${job.id}`;
        } else {
          await database().sql`update jobs set state = 'FAILED', locked_at = null, lease_token = null, last_error = ${message}, available_at = now() + make_interval(secs => least(3600, power(2, attempts)::int * 5)) where id = ${job.id}`;
        }
      }
    }
  }
  return { cleanedArtefacts, expired, processed };
});
