import { z } from "zod";
import { verifyReceipt } from "@mayi/receipts";
import { createError, defineEventHandler, getHeader } from "h3";
import { bodyAs } from "../../utils/http";
import { timingSafeEqual } from "../../utils/crypto";
import { database } from "../../utils/runtime";
import { signingKeys } from "../../utils/signer";
import { getConfig } from "../../utils/config";
import { audit } from "../../utils/auth";

const Consume = z.object({ receipt: z.string().min(40), actionDigest: z.string().length(64), manifestDigest: z.string().length(64) });

export default defineEventHandler(async (event) => {
  const input = await bodyAs(event, Consume);
  const unverified = JSON.parse(Buffer.from(input.receipt.split(".")[1] ?? "", "base64url").toString()) as { aud?: string; jti?: string };
  const audience = typeof unverified.aud === "string" ? unverified.aud : "";
  let consumers: Record<string, string>;
  try { consumers = JSON.parse(process.env.CONSUMER_API_KEYS ?? "{}"); } catch { throw createError({ statusCode: 500, statusMessage: "Consumer configuration is invalid" }); }
  const supplied = getHeader(event, "x-consumer-key") ?? "";
  if (!consumers[audience] || !timingSafeEqual(consumers[audience], supplied)) throw createError({ statusCode: 401, statusMessage: "Relying-party authentication failed" });
  const claims = await verifyReceipt(input.receipt, (await signingKeys()).publicJwk, { issuer: getConfig().receiptIssuer, audience });
  if (claims.enforcement !== "consumed") throw createError({ statusCode: 409, statusMessage: "Receipt is not consumable" });
  if (claims.action_digest !== input.actionDigest || claims.artefact_manifest_digest !== input.manifestDigest) throw createError({ statusCode: 409, statusMessage: "Exact action or artefact manifest does not match receipt" });
  await database().sql.begin("isolation level serializable", async (sql) => {
    const rows = await sql`select consumed_at, expires_at from receipts where id = ${claims.jti} and compact_jws = ${input.receipt} and audience = ${audience} for update`;
    const row = rows[0];
    if (!row) throw createError({ statusCode: 404, statusMessage: "Receipt not found" });
    if (row.consumed_at) throw createError({ statusCode: 409, statusMessage: "Receipt was already consumed" });
    const updated = await sql`update receipts set consumed_at = now(), consumed_by = ${audience} where id = ${claims.jti} and consumed_at is null and expires_at > now() returning id`;
    if (!updated.length) throw createError({ statusCode: 410, statusMessage: "Receipt expired" });
    await audit({ workspaceId: claims.workspace_id, actorType: "system", eventType: "receipt.consumed", subjectType: "receipt", subjectId: claims.jti, metadata: { audience } }, sql);
  });
  return { consumed: true, receiptId: claims.jti, requestId: claims.sub };
});
