import { z } from "zod";
import { createId, Id } from "@mayi/contracts";
import { createError, defineEventHandler } from "h3";
import { bodyAs } from "../../utils/http";
import { audit, requireUser } from "../../utils/auth";
import { deliverForwardingHttp, validateOutboundUrl } from "../../utils/forwarding";
import { database } from "../../utils/runtime";
import { randomToken } from "../../utils/crypto";

const Destination = z.object({
  name: z.string().min(1).max(100), endpoint: z.url(), mode: z.enum(["notify_only", "may_decide"]).default("notify_only"),
  publicJwk: z.record(z.string(), z.unknown()).optional(), mappedUserId: Id.optional(),
});

export default defineEventHandler(async (event) => {
  const auth = await requireUser(event); if (auth.role !== "OWNER") throw createError({ statusCode: 403, statusMessage: "Owner access required" });
  const input = await bodyAs(event, Destination); const target = await validateOutboundUrl(input.endpoint);
  if (input.mode === "may_decide" && (!input.publicJwk || !input.mappedUserId)) throw createError({ statusCode: 422, statusMessage: "Decision destinations require a public JWK and mapped approver" });
  if (input.mappedUserId) {
    const member = await database().sql`select 1 from memberships where workspace_id = ${auth.workspaceId} and user_id = ${input.mappedUserId} and active and revoked_at is null and role in ('OWNER','APPROVER')`;
    if (!member.length) throw createError({ statusCode: 422, statusMessage: "Mapped approver is not eligible" });
  }
  const challenge = randomToken();
  const response = await deliverForwardingHttp(target, {
    headers: { "content-type": "application/json", "user-agent": "MayI-Endpoint-Verification/1" },
    body: JSON.stringify({ type: "mayi.endpoint_verification", challenge }),
  });
  if (response.status < 200 || response.status >= 300) throw createError({ statusCode: 422, statusMessage: "Webhook verification request was not accepted" });
  const proof = (() => {
    try { return JSON.parse(new TextDecoder().decode(response.body)) as { challenge?: string }; }
    catch { return null; }
  })();
  if (proof?.challenge !== challenge) throw createError({ statusCode: 422, statusMessage: "Webhook did not return the ownership challenge" });
  const id = createId();
  const [row] = await database().sql`
    insert into forwarding_destinations (id, workspace_id, type, name, endpoint, mode, public_jwk, mapped_user_id, verified_at)
    values (${id}, ${auth.workspaceId}, 'WEBHOOK', ${input.name}, ${target.url.toString()}, ${input.mode}, ${input.publicJwk ? JSON.stringify(input.publicJwk) : null}::jsonb, ${input.mappedUserId ?? null}, now()) returning id
  `;
  await audit({ workspaceId: auth.workspaceId, actorType: "user", actorId: auth.userId, eventType: "forwarding.destination_verified", subjectType: "destination", subjectId: String(row!.id), metadata: { mode: input.mode } });
  return { id: String(row!.id), ...input, endpoint: target.url.toString(), verified: true };
});
