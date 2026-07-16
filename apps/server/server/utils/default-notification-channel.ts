import { createId } from "@mayi/contracts";
import type { DatabaseSql } from "@mayi/db";

// Signing up is an assertion of ownership of the account email address, so it
// becomes a born-verified default notification channel alongside mobile push
// (which is fanned out unconditionally in queuePendingNotifications and needs
// no forwarding row). Additional addresses still go through the code
// verification flow in /api/forwarding/email. If account email changes are
// ever supported, this destination must be updated with users.email.
export async function createDefaultEmailChannel(
  sql: DatabaseSql,
  input: { workspaceId: string; userId: string; email: string },
): Promise<void> {
  const destinationId = createId();
  await sql`
    insert into forwarding_destinations (id, workspace_id, type, name, endpoint, mode, mapped_user_id, verified_at)
    values (${destinationId}, ${input.workspaceId}, 'EMAIL', 'Account email', ${input.email.toLowerCase()}, 'notify_only', ${input.userId}, now())
  `;
  await sql`
    insert into forwarding_rules (id, workspace_id, destination_id, action_kind)
    values (${createId()}, ${input.workspaceId}, ${destinationId}, '*')
  `;
}
