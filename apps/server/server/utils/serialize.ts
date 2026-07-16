import { Action, InputAnswer, InputOption, type Artefact, type InputState, type InputType } from "@mayi/contracts";
import type { DatabaseSql } from "@mayi/db";
import { database } from "./runtime";

export async function serializeApproval(
  workspaceId: string,
  approvalId: string,
  sql: DatabaseSql = database().sql,
) {
  const rows = await sql`
    select a.*, r.compact_jws
    from approvals a left join receipts r on r.approval_id = a.id
    where a.workspace_id = ${workspaceId} and a.id = ${approvalId} limit 1
  `;
  const row = rows[0];
  if (!row) return null;
  const artefactRows = await sql`
    select f.id, aa.ordinal, f.filename, f.media_type, f.size, f.sha256
    from approval_artefacts aa join artefacts f on f.id = aa.artefact_id
    where aa.approval_id = ${approvalId} and f.workspace_id = ${workspaceId}
    order by aa.ordinal
  `;
  return {
    id: String(row.id), workspaceId: String(row.workspace_id), agentId: String(row.agent_id), state: row.state,
    action: Action.parse(row.action), explanation: row.explanation, enforcement: row.enforcement,
    actionDigest: row.action_digest, manifestDigest: row.manifest_digest,
    artefacts: artefactRows.map((item, ordinal): Artefact => ({
      id: String(item.id), ordinal, filename: String(item.filename), mediaType: item.media_type as Artefact["mediaType"],
      size: Number(item.size), sha256: String(item.sha256),
    })),
    createdAt: new Date(String(row.created_at)).toISOString(), sealedAt: row.sealed_at ? new Date(String(row.sealed_at)).toISOString() : null,
    expiresAt: new Date(String(row.expires_at)).toISOString(), decidedAt: row.decided_at ? new Date(String(row.decided_at)).toISOString() : null,
    decisionComment: row.decision_comment, approverId: row.approver_id ? String(row.approver_id) : null,
    ...(row.compact_jws ? { receipt: String(row.compact_jws) } : {}),
  };
}

export async function serializeInput(
  workspaceId: string,
  inputId: string,
  sql: DatabaseSql = database().sql,
) {
  const rows = await sql`
    select * from inputs where workspace_id = ${workspaceId} and id = ${inputId} limit 1
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    id: String(row.id), type: row.type as InputType, prompt: String(row.prompt),
    options: row.options === null ? null : InputOption.array().parse(row.options),
    allowFreeform: Boolean(row.allow_freeform), state: row.state as InputState,
    answer: row.answer === null ? null : InputAnswer.parse(row.answer),
    attestation: row.attestation === null ? null : String(row.attestation),
    respondentId: row.respondent_id === null ? null : String(row.respondent_id),
    agentId: String(row.agent_id),
    createdAt: new Date(String(row.created_at)).toISOString(), expiresAt: new Date(String(row.expires_at)).toISOString(),
    answeredAt: row.answered_at ? new Date(String(row.answered_at)).toISOString() : null,
    cancelledAt: row.cancelled_at ? new Date(String(row.cancelled_at)).toISOString() : null,
  };
}
