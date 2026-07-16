import { actionName, Action } from "@mayi/contracts";
import { defineEventHandler } from "h3";
import { database } from "../../../utils/runtime";
import { audit } from "../../../utils/auth";
import { deliverForwardingHttp, signWebhook, validateOutboundUrl } from "../../../utils/forwarding";
import {
  CALLBACK_JOB_TYPE,
  activateApprovalCallback,
  activateInputCallback,
  claimNextJob,
  isCallbackJobType,
  markCallbackDelivered,
  markCallbackFailed,
  markOutboxJobFailed,
  markOutboxJobSucceeded,
  sendApprovalCallback,
  sendInputCallback,
  type NonCallbackJobResult,
  type OutboxJob,
} from "../../../utils/callback-outbox";
import { renderApprovalRequestedEmail, renderInputRequestedEmail } from "@mayi/email";
import { emailConfigured, sendEmail } from "../../../utils/email-client";
import { requireCronSecret } from "../../../utils/internal-auth";
import { cleanupExpiredStagedArtefacts } from "../../../utils/staged-artefact-cleanup";

type Job = OutboxJob;
export const PROVIDER_TOTAL_TIMEOUT_MS = 10_000;

export async function deliverProviderRequest(
  input: string | URL,
  init: RequestInit,
  options: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? PROVIDER_TOTAL_TIMEOUT_MS);
  try {
    const response = await (options.fetch ?? fetch)(input, { ...init, signal: controller.signal });
    void response.body?.cancel().catch(() => undefined);
    return response;
  } finally {
    clearTimeout(timeout);
  }
}

export async function auditJobSucceeded(
  job: Job,
  writer: (input: Parameters<typeof audit>[0]) => Promise<unknown> = audit,
): Promise<boolean> {
  try {
    await writer({
      workspaceId: job.workspace_id,
      actorType: "system",
      eventType: "job.succeeded",
      subjectType: "job",
      subjectId: job.id,
      metadata: { type: job.type },
    });
    return true;
  } catch {
    return false;
  }
}

export async function pendingNotificationIsCurrent(job: Job): Promise<boolean> {
  const inputId = job.payload.inputId;
  if (inputId) {
    const rows = await database().sql`
      select 1 from inputs
      where id = ${inputId} and workspace_id = ${job.workspace_id}
        and state = 'PENDING' and expires_at > now()
    `;
    return Boolean(rows[0]);
  }
  const approvalId = job.payload.approvalId;
  if (!approvalId) return false;
  const rows = await database().sql`
    select 1 from approvals
    where id = ${approvalId} and workspace_id = ${job.workspace_id}
      and state = 'PENDING' and expires_at > now()
  `;
  return Boolean(rows[0]);
}

async function sendExpoPush(messages: unknown[]): Promise<void> {
  const response = await deliverProviderRequest("https://exp.host/--/api/v2/push/send", { method: "POST", headers: { "content-type": "application/json", ...(process.env.EXPO_ACCESS_TOKEN ? { authorization: `Bearer ${process.env.EXPO_ACCESS_TOKEN}` } : {}) }, body: JSON.stringify(messages) });
  if (!response.ok) throw new Error(`Expo push returned ${response.status}`);
}

async function push(job: Job): Promise<void> {
  const approvalId = job.payload.approvalId;
  if (!approvalId) throw new Error("Missing approval ID");
  const devices = await database().sql`
    select distinct d.expo_push_token from devices d join eligible_approvers e on e.user_id = d.user_id and e.workspace_id = d.workspace_id
    where e.approval_id = ${approvalId} and d.workspace_id = ${job.workspace_id} and d.active
  `;
  if (!devices.length) return;
  await sendExpoPush(devices.map((row) => ({ to: row.expo_push_token, title: "Approval requested", body: "Open May I? to review.", data: { approvalId }, sound: "default", channelId: "default" })));
}

async function pushInput(job: Job): Promise<void> {
  const inputId = job.payload.inputId;
  if (!inputId) throw new Error("Missing input ID");
  const devices = await database().sql`
    select distinct d.expo_push_token from devices d join input_eligible_respondents e on e.user_id = d.user_id and e.workspace_id = d.workspace_id
    where e.input_id = ${inputId} and d.workspace_id = ${job.workspace_id} and d.active
  `;
  if (!devices.length) return;
  await sendExpoPush(devices.map((row) => ({ to: row.expo_push_token, title: "Input requested", body: "Open May I? to answer.", data: { inputId }, sound: "default", channelId: "default" })));
}

async function webhook(job: Job): Promise<NonCallbackJobResult> {
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
  const target = await validateOutboundUrl(String(row.endpoint));
  const response = await deliverForwardingHttp(target, {
    headers: {
      "content-type": "application/json",
      "x-mayi-delivery-id": deliveryId,
      "x-mayi-signature": await signWebhook(payload),
      "user-agent": "MayI-Webhook/1",
    },
    body: JSON.stringify(payload),
  });
  if (response.status < 200 || response.status >= 300) throw new Error(`Webhook returned ${response.status}`);
  return { deliveryId, responseCode: response.status };
}

/** "in 14 minutes" — the same phrasing the app uses, computed at send time. */
export function relativeExpiry(expiresAt: Date, now = Date.now()): string {
  const delta = (expiresAt.getTime() - now) / 1000;
  const relative = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  const units: Array<[limit: number, seconds: number, unit: Intl.RelativeTimeFormatUnit]> = [
    [60, 1, "second"], [3600, 60, "minute"], [86_400, 3600, "hour"], [Infinity, 86_400, "day"],
  ];
  for (const [limit, seconds, unit] of units) {
    if (Math.abs(delta) < limit) return relative.format(Math.round(delta / seconds), unit);
  }
  return expiresAt.toISOString();
}

async function email(job: Job): Promise<NonCallbackJobResult> {
  const { approvalId, destinationId, deliveryId } = job.payload;
  if (!approvalId || !destinationId || !deliveryId) throw new Error("Incomplete email job");
  if (!emailConfigured()) throw new Error("Email delivery is not configured");
  const rows = await database().sql`
    select d.endpoint, a.action, a.explanation, a.high_risk, a.expires_at,
      ag.name as agent_name, w.name as workspace_name
    from forwarding_destinations d
    join approvals a on a.id = ${approvalId} and a.workspace_id = d.workspace_id
    join agents ag on ag.id = a.agent_id
    join workspaces w on w.id = a.workspace_id
    where d.id = ${destinationId} and d.workspace_id = ${job.workspace_id} and d.type = 'EMAIL' and d.active and d.verified_at is not null
  `;
  const row = rows[0]; if (!row) throw new Error("Email destination no longer exists"); const action = Action.parse(row.action);
  const expiresAt = new Date(row.expires_at as Date);
  const kind = actionName(action);
  // The web app is co-served by this server in production; WEB_ORIGIN overrides for
  // dev where Vite hosts it on its own port.
  const webOrigin = process.env.WEB_ORIGIN ?? process.env.PUBLIC_ORIGIN ?? "http://localhost:3000";
  const html = await renderApprovalRequestedEmail({
    actionKind: kind,
    explanation: String(row.explanation),
    agentName: String(row.agent_name),
    workspaceName: String(row.workspace_name),
    highRisk: Boolean(row.high_risk),
    expiresAtIso: expiresAt.toISOString(),
    expiresInText: relativeExpiry(expiresAt),
    reviewUrl: `${webOrigin}/?approval=${approvalId}`,
    approvalId,
  });
  await sendEmail({ to: String(row.endpoint), subject: `May I ${kind}? — approval requested`, html });
  return { deliveryId, responseCode: 200 };
}

async function emailInput(job: Job): Promise<NonCallbackJobResult> {
  const { inputId, destinationId } = job.payload;
  if (!inputId || !destinationId) throw new Error("Incomplete input email job");
  if (!emailConfigured()) throw new Error("Email delivery is not configured");
  const rows = await database().sql`
    select d.endpoint, i.prompt, i.expires_at, ag.name as agent_name, w.name as workspace_name
    from forwarding_destinations d
    join inputs i on i.id = ${inputId} and i.workspace_id = d.workspace_id
    join agents ag on ag.id = i.agent_id
    join workspaces w on w.id = i.workspace_id
    where d.id = ${destinationId} and d.workspace_id = ${job.workspace_id} and d.type = 'EMAIL' and d.active and d.verified_at is not null
  `;
  const row = rows[0]; if (!row) throw new Error("Email destination no longer exists");
  const expiresAt = new Date(row.expires_at as Date);
  // The web app is co-served by this server in production; WEB_ORIGIN overrides for
  // dev where Vite hosts it on its own port.
  const webOrigin = process.env.WEB_ORIGIN ?? process.env.PUBLIC_ORIGIN ?? "http://localhost:3000";
  const html = await renderInputRequestedEmail({
    prompt: String(row.prompt),
    agentName: String(row.agent_name),
    workspaceName: String(row.workspace_name),
    expiresInText: relativeExpiry(expiresAt),
    reviewUrl: `${webOrigin}/?input=${inputId}`,
  });
  await sendEmail({ to: String(row.endpoint), subject: `May I ask? — ${String(row.agent_name)} needs your input`, html });
  return { responseCode: 200 };
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
  let expiredInputs = 0;
  for (; expiredInputs < 100; expiredInputs++) {
    const didExpire = await database().sql.begin(async (sql) => {
      const rows = await sql`
        select id, workspace_id from inputs
        where state = 'PENDING' and expires_at <= now()
        order by expires_at for update skip locked limit 1
      `;
      if (!rows[0]) return false;
      const inputId = String(rows[0].id);
      const workspaceId = String(rows[0].workspace_id);
      await sql`update inputs set state = 'EXPIRED' where id = ${inputId} and state = 'PENDING'`;
      await activateInputCallback(sql, inputId);
      await audit({ workspaceId, actorType: "system", eventType: "input.expired", subjectType: "input", subjectId: inputId }, sql);
      return true;
    });
    if (!didExpire) break;
  }
  let processed = 0;
  for (; processed < 25; processed++) {
    const job = await claimNextJob(); if (!job) break;
    let completed: boolean;
    try {
      if (isCallbackJobType(job.type)) {
        if (job.type === CALLBACK_JOB_TYPE) await sendApprovalCallback(job);
        else await sendInputCallback(job);
        completed = await markCallbackDelivered(job);
      } else {
        if (!await pendingNotificationIsCurrent(job)) {
          completed = await markOutboxJobSucceeded(job, {
            ...(job.payload.deliveryId ? { deliveryId: job.payload.deliveryId } : {}),
            skipped: true,
          });
          if (completed) await auditJobSucceeded(job);
          continue;
        }
        let result: NonCallbackJobResult = {};
        if (job.type === "push.approval_pending") await push(job);
        else if (job.type === "webhook.approval_pending") result = await webhook(job);
        else if (job.type === "email.approval_pending") result = await email(job);
        else if (job.type === "push.input_pending") await pushInput(job);
        else if (job.type === "email.input_pending") result = await emailInput(job);
        else throw new Error("Unknown job type");
        completed = await markOutboxJobSucceeded(job, result);
      }
    } catch (error) {
      if (isCallbackJobType(job.type)) {
        await markCallbackFailed(job, error);
      } else {
        await markOutboxJobFailed(job, error);
      }
      continue;
    }
    if (completed) {
      // Delivery is already durably complete. Audit outages must not reclassify
      // the job and cause a duplicate external side effect.
      await auditJobSucceeded(job);
    }
  }
  return { cleanedArtefacts, expired, expiredInputs, processed };
});
