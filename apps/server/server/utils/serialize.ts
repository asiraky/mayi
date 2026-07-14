import type { Artefact } from "@mayi/contracts";
import { database } from "./runtime";

export async function serializeApproval(workspaceId: string, approvalId: string) {
  const rows = await database().sql`
    select a.*, r.compact_jws
    from approvals a left join receipts r on r.approval_id = a.id
    where a.workspace_id = ${workspaceId} and a.id = ${approvalId} limit 1
  `;
  const row = rows[0];
  if (!row) return null;
  const artefactRows = await database().sql`
    select f.id, aa.ordinal, f.filename, f.media_type, f.size, f.sha256
    from approval_artefacts aa join artefacts f on f.id = aa.artefact_id
    where aa.approval_id = ${approvalId} and f.workspace_id = ${workspaceId}
    order by aa.ordinal
  `;
  return {
    id: String(row.id), workspaceId: String(row.workspace_id), agentId: String(row.agent_id), state: row.state,
    action: row.action, explanation: row.explanation, enforcement: row.enforcement,
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
