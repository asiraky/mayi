import type { DatabaseSql } from "@mayi/db";
import { Id } from "@mayi/contracts";
import { createError } from "h3";

export const CONNECTION_LABEL_MAX_CHARS = 100;

/**
 * The optional `label` names one installation of a client ("HARNESST — ledger-team")
 * so several connections from the same client stay distinguishable. Absent or blank
 * means "no label"; anything else must fit the agent name column's contract.
 */
export function parseConnectionLabel(value: unknown): string | null {
  if (value == null) return null;
  // Control characters would render invisibly on the consent screen the user is trusting.
  const label = String(value).replace(/\p{Cc}/gu, " ").trim();
  if (!label) return null;
  if (label.length > CONNECTION_LABEL_MAX_CHARS) {
    throw createError({ statusCode: 400, statusMessage: `Connection label must be at most ${CONNECTION_LABEL_MAX_CHARS} characters` });
  }
  return label;
}

export function parseConnectionId(value: unknown): string | null {
  if (value == null || value === "") return null;
  const parsed = Id.safeParse(String(value));
  if (!parsed.success) throw createError({ statusCode: 400, statusMessage: "Connection identifier is invalid" });
  return parsed.data;
}

export type ReconnectTarget =
  | { status: "ok"; agentId: string; name: string }
  // Deliberately covers "does not exist", "other workspace", and "other client" alike,
  // so the response never confirms an agent id outside the caller's own workspace.
  | { status: "not_found" }
  | { status: "owner_revoked" };

/**
 * A reconnect may only land on an agent that belongs to the same OAuth client and the
 * workspace the consenting user is acting in. An owner's revoke is final; an automatic
 * revoke (refresh-token reuse) is recoverable by re-authorizing.
 */
export async function findReconnectTarget(
  sql: DatabaseSql,
  input: { agentId: string; clientId: string; workspaceId: string; lock?: boolean },
): Promise<ReconnectTarget> {
  const rows = await sql`
    select id, name, revoked_by from agents
    where id = ${input.agentId} and client_id = ${input.clientId} and workspace_id = ${input.workspaceId}
    ${input.lock ? sql`for update` : sql``}
  `;
  const row = rows[0];
  if (!row) return { status: "not_found" };
  if (row.revoked_by !== null) return { status: "owner_revoked" };
  return { status: "ok", agentId: String(row.id), name: String(row.name) };
}
