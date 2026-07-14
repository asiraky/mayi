import { z } from "zod";
import { createId } from "@mayi/contracts";
import { createError, defineEventHandler } from "h3";
import { bodyAs } from "../../utils/http";
import { audit, requireUser } from "../../utils/auth";
import { randomToken, tokenHash } from "../../utils/crypto";
import { database } from "../../utils/runtime";

const CreateAgent = z.object({ name: z.string().min(1).max(100), scopes: z.array(z.enum(["approval:create", "approval:read", "approval:cancel"])).min(1) });

export default defineEventHandler(async (event) => {
  const auth = await requireUser(event);
  if (auth.role !== "OWNER") throw createError({ statusCode: 403, statusMessage: "Owner access required" });
  const input = await bodyAs(event, CreateAgent);
  const id = createId();
  const token = `mayi_${randomToken()}`;
  const [agent] = await database().sql`
    insert into agents (id, workspace_id, name, scopes, credential_hash, created_by)
    values (${id}, ${auth.workspaceId}, ${input.name}, ${input.scopes}, ${await tokenHash(token)}, ${auth.userId}) returning id
  `;
  await audit({ workspaceId: auth.workspaceId, actorType: "user", actorId: auth.userId, eventType: "agent.created", subjectType: "agent", subjectId: String(agent!.id), metadata: { scopes: input.scopes } });
  return { id: String(agent!.id), name: input.name, scopes: input.scopes, token };
});
