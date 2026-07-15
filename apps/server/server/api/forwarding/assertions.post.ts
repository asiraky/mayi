import { z } from "zod";
import { actionAudience, Action, createId, Id } from "@mayi/contracts";
import { importJWK, jwtVerify } from "jose";
import { signReceipt } from "@mayi/receipts";
import { createError, defineEventHandler } from "h3";
import { database } from "../../utils/runtime";
import { getConfig } from "../../utils/config";
import { signingKeys } from "../../utils/signer";
import { audit } from "../../utils/auth";
import { serializeApproval } from "../../utils/serialize";
import { activateApprovalCallback } from "../../utils/callback-outbox";
import { readBoundedJsonBody } from "../../utils/http";

const AssertionClaims = z.object({
  iss: Id, aud: z.union([z.string(), z.array(z.string())]), iat: z.number().int(), exp: z.number().int(),
  destination_id: Id, workspace_id: Id, request_id: Id, action_digest: z.string().length(64),
  artefact_manifest_digest: z.string().length(64), policy_version: z.number().int().positive(), decision: z.enum(["APPROVED", "DENIED"]),
  actor: z.string().min(1).max(200), nonce: z.string().min(16).max(200), comment: z.string().max(4000).optional(),
});

export default defineEventHandler(async (event) => {
  const body = z.object({ assertion: z.string().min(40) }).parse(await readBoundedJsonBody(event, 128 * 1024));
  let hint: { destination_id?: string };
  try { hint = JSON.parse(Buffer.from(body.assertion.split(".")[1] ?? "", "base64url").toString()); } catch { throw createError({ statusCode: 400, statusMessage: "Malformed assertion" }); }
  if (!hint.destination_id) throw createError({ statusCode: 400, statusMessage: "Assertion lacks destination binding" });
  const destinations = await database().sql`select * from forwarding_destinations where id = ${hint.destination_id} and active and verified_at is not null and mode = 'may_decide'`;
  const destination = destinations[0]; if (!destination?.public_jwk || !destination.mapped_user_id) throw createError({ statusCode: 403, statusMessage: "Destination has no current decision authority" });
  const key = await importJWK(destination.public_jwk as never);
  const verified = await jwtVerify(body.assertion, key, { issuer: String(destination.id), audience: getConfig().publicOrigin, algorithms: ["EdDSA", "ES256"] });
  const claims = AssertionClaims.parse(verified.payload);
  if (claims.destination_id !== destination.id || claims.workspace_id !== destination.workspace_id) throw createError({ statusCode: 403, statusMessage: "Assertion trust relationship mismatch" });
  await database().sql.begin(async (sql) => {
    const rows = await sql`
      select a.*, now() as database_now from approvals a join forwarding_deliveries fd on fd.approval_id = a.id
      where a.id = ${claims.request_id} and a.workspace_id = ${claims.workspace_id} and fd.destination_id = ${claims.destination_id} and fd.state = 'DELIVERED' for update of a
    `;
    const approval = rows[0]; if (!approval) throw createError({ statusCode: 404, statusMessage: "Exact forwarded request not found" });
    if (approval.state !== "PENDING") throw createError({ statusCode: 409, statusMessage: "Request is no longer pending" });
    if (String(approval.action_digest) !== claims.action_digest || String(approval.manifest_digest) !== claims.artefact_manifest_digest || Number(approval.policy_version) !== claims.policy_version) throw createError({ statusCode: 409, statusMessage: "Assertion is not bound to the sealed request" });
    if (new Date(approval.expires_at as Date) <= new Date(approval.database_now as Date)) {
      await sql`update approvals set state = 'EXPIRED', decided_at = now() where id = ${claims.request_id}`;
      await activateApprovalCallback(sql, claims.request_id);
      await audit({ workspaceId: claims.workspace_id, actorType: "system", eventType: "approval.expired", subjectType: "approval", subjectId: claims.request_id }, sql); return;
    }
    const eligible = await sql`
      select 1 from eligible_approvers e join memberships m on m.workspace_id = e.workspace_id and m.user_id = e.user_id and m.active and m.revoked_at is null
      join users u on u.id = e.user_id and u.active and u.deleted_at is null
      where e.approval_id = ${claims.request_id} and e.workspace_id = ${claims.workspace_id} and e.user_id = ${destination.mapped_user_id}
    `;
    if (!eligible.length) throw createError({ statusCode: 403, statusMessage: "Mapped approver is no longer eligible" });
    try { await sql`insert into external_nonces (destination_id, nonce) values (${claims.destination_id}, ${claims.nonce})`; }
    catch { throw createError({ statusCode: 409, statusMessage: "External assertion nonce was already used" }); }
    await sql`update approvals set state = ${claims.decision}, decided_at = now(), approver_id = ${destination.mapped_user_id}, decision_comment = ${claims.comment ?? null} where id = ${claims.request_id}`;
    if (claims.decision === "APPROVED") {
      const receiptId = createId(); const now = new Date(approval.database_now as Date); const expires = new Date(approval.expires_at as Date);
      const exp = Math.min(Math.floor(expires.getTime() / 1000), Math.floor(now.getTime() / 1000) + 900); const keys = await signingKeys();
      const audience = actionAudience(Action.parse(approval.action)) ?? getConfig().receiptAudience;
      const token = await signReceipt({ iss: getConfig().receiptIssuer, aud: audience, sub: claims.request_id, jti: receiptId,
        iat: Math.floor(now.getTime() / 1000), exp, workspace_id: claims.workspace_id, agent_id: String(approval.agent_id), policy_version: claims.policy_version,
        action_digest: claims.action_digest, artefact_manifest_digest: claims.artefact_manifest_digest, approver_id: String(destination.mapped_user_id), enforcement: approval.enforcement,
      }, keys.privateJwk, keys.kid);
      await sql`insert into receipts (id, approval_id, workspace_id, audience, compact_jws, expires_at) values (${receiptId}, ${claims.request_id}, ${claims.workspace_id}, ${audience}, ${token}, to_timestamp(${exp}))`;
    }
    await activateApprovalCallback(sql, claims.request_id);
    await audit({ workspaceId: claims.workspace_id, actorType: "system", eventType: `approval.external_${claims.decision.toLowerCase()}`, subjectType: "approval", subjectId: claims.request_id, metadata: { destinationId: claims.destination_id, actor: claims.actor } }, sql);
  });
  return serializeApproval(claims.workspace_id, claims.request_id);
});
