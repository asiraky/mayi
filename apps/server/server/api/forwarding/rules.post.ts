import { z } from "zod";
import { createError, defineEventHandler } from "h3";
import { bodyAs } from "../../utils/http";
import { audit, requireUser } from "../../utils/auth";
import { database } from "../../utils/runtime";
const Rule = z.object({ destinationId: z.uuid(), actionKind: z.string().min(1).max(100), includeAction: z.boolean().default(false), includeArtefactMetadata: z.boolean().default(false) });
export default defineEventHandler(async (event) => {
  const auth = await requireUser(event); if (auth.role !== "OWNER") throw createError({ statusCode: 403, statusMessage: "Owner access required" }); const input = await bodyAs(event, Rule);
  const destination = await database().sql`select 1 from forwarding_destinations where id = ${input.destinationId} and workspace_id = ${auth.workspaceId} and active and verified_at is not null`;
  if (!destination.length) throw createError({ statusCode: 404, statusMessage: "Verified destination not found" });
  const [row] = await database().sql`insert into forwarding_rules (workspace_id, destination_id, action_kind, include_action, include_artefact_metadata) values (${auth.workspaceId}, ${input.destinationId}, ${input.actionKind}, ${input.includeAction}, ${input.includeArtefactMetadata}) returning id`;
  await audit({ workspaceId: auth.workspaceId, actorType: "user", actorId: auth.userId, eventType: "forwarding.rule_created", subjectType: "forwarding_rule", subjectId: String(row!.id) }); return { id: String(row!.id), ...input };
});
