import { actionName, createId, type Action, type InputType } from "@mayi/contracts";
import type { DatabaseSql } from "@mayi/db";

export async function queuePendingNotifications(
  sql: DatabaseSql,
  input: { workspaceId: string; approvalId: string; action: Action },
): Promise<void> {
  await sql`
    insert into jobs (id, workspace_id, type, dedupe_key, payload)
    values (${createId()}, ${input.workspaceId}, 'push.approval_pending', ${input.approvalId}, ${JSON.stringify({ approvalId: input.approvalId })}::jsonb)
    on conflict do nothing
  `;

  const rules = await sql`
    select r.destination_id, d.type
    from forwarding_rules r
    join forwarding_destinations d on d.id = r.destination_id
    where r.workspace_id = ${input.workspaceId}
      and r.active
      and d.active
      and d.verified_at is not null
      and (r.action_kind = '*' or r.action_kind = ${actionName(input.action)})
  `;

  for (const rule of rules) {
    const deliveries = await sql`
      insert into forwarding_deliveries (id, workspace_id, approval_id, destination_id, origin_id)
      values (${createId()}, ${input.workspaceId}, ${input.approvalId}, ${rule.destination_id}, ${input.approvalId})
      on conflict do nothing
      returning id
    `;
    if (!deliveries[0]) continue;
    await sql`
      insert into jobs (id, workspace_id, type, dedupe_key, payload)
      values (
        ${createId()},
        ${input.workspaceId},
        ${rule.type === "EMAIL" ? "email.approval_pending" : "webhook.approval_pending"},
        ${`${input.approvalId}:${rule.destination_id}`},
        ${JSON.stringify({
          approvalId: input.approvalId,
          destinationId: String(rule.destination_id),
          deliveryId: String(deliveries[0].id),
        })}::jsonb
      )
      on conflict do nothing
    `;
  }
}

/**
 * Inputs carry no enforced action, so action-scoped forwarding rules (e.g.
 * 'finance.transfer') never match a generic ask: only destinations with an active,
 * verified match-all ('*') EMAIL rule are told a human is needed. Webhook
 * forwarding stays approval-only because its payload contract is action-shaped.
 */
export async function queueInputNotifications(
  sql: DatabaseSql,
  input: { workspaceId: string; inputId: string; type: InputType; prompt: string },
): Promise<void> {
  await sql`
    insert into jobs (id, workspace_id, type, dedupe_key, payload)
    values (${createId()}, ${input.workspaceId}, 'push.input_pending', ${input.inputId}, ${JSON.stringify({ inputId: input.inputId })}::jsonb)
    on conflict do nothing
  `;

  const rules = await sql`
    select distinct r.destination_id
    from forwarding_rules r
    join forwarding_destinations d on d.id = r.destination_id
    where r.workspace_id = ${input.workspaceId}
      and r.active
      and d.active
      and d.type = 'EMAIL'
      and d.verified_at is not null
      and r.action_kind = '*'
  `;

  for (const rule of rules) {
    await sql`
      insert into jobs (id, workspace_id, type, dedupe_key, payload)
      values (
        ${createId()},
        ${input.workspaceId},
        'email.input_pending',
        ${`${input.inputId}:${rule.destination_id}`},
        ${JSON.stringify({ inputId: input.inputId, destinationId: String(rule.destination_id) })}::jsonb
      )
      on conflict do nothing
    `;
  }
}
