import { defineEventHandler } from "h3";
import { requireUser } from "../../utils/auth";
import { database } from "../../utils/runtime";

export default defineEventHandler(async (event) => {
  const auth = await requireUser(event);
  const [row] = await database().sql`
    select u.email, u.display_name, w.name from users u join workspaces w on w.id = ${auth.workspaceId} where u.id = ${auth.userId}
  `;
  return { user: { id: auth.userId, email: row!.email, displayName: row!.display_name }, workspace: { id: auth.workspaceId, name: row!.name }, recentAuthAt: auth.recentAuthAt.toISOString() };
});
