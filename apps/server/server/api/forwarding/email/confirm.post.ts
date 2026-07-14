import { z } from "zod";
import { createError, defineEventHandler } from "h3";
import { bodyAs } from "../../../utils/http";
import { audit, requireUser } from "../../../utils/auth";
import { database } from "../../../utils/runtime";
import { tokenHash } from "../../../utils/crypto";

const Input = z.object({ destinationId: z.uuid(), code: z.string().min(10).max(100) });
export default defineEventHandler(async (event) => {
  const auth = await requireUser(event); if (auth.role !== "OWNER") throw createError({ statusCode: 403, statusMessage: "Owner access required" }); const input = await bodyAs(event, Input);
  const rows = await database().sql`
    update forwarding_destinations set verified_at = now(), verification_hash = null, verification_expires_at = null
    where id = ${input.destinationId} and workspace_id = ${auth.workspaceId} and type = 'EMAIL' and verified_at is null
      and verification_expires_at > now() and verification_hash = ${await tokenHash(input.code)} returning id
  `;
  if (!rows.length) throw createError({ statusCode: 400, statusMessage: "Verification code is invalid or expired" });
  await audit({ workspaceId: auth.workspaceId, actorType: "user", actorId: auth.userId, eventType: "forwarding.email_verified", subjectType: "destination", subjectId: input.destinationId }); return { verified: true };
});
