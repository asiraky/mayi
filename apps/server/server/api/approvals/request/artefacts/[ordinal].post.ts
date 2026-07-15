import { canonicalDigest, createId, sha256 } from "@mayi/contracts";
import { createError, defineEventHandler, getHeader, getRouterParam, readRawBody } from "h3";
import { requireAgent } from "../../../../utils/auth";
import { requireIdempotencyKey } from "../../../../utils/http";
import { database, objects } from "../../../../utils/runtime";
import {
  ARTEFACT_MEDIA_TYPES,
  MAX_ARTEFACT_BYTES,
  detectArtefactMediaType,
  type ArtefactMediaType,
} from "../../../../utils/artefacts";

function filenameFromHeader(value: string | undefined): string {
  if (!value) return "";
  try {
    return decodeURIComponent(value).trim();
  } catch {
    return "";
  }
}

export default defineEventHandler(async (event) => {
  const auth = await requireAgent(event, "approval:create");
  const requestKey = requireIdempotencyKey(event);
  const ordinal = Number(getRouterParam(event, "ordinal"));
  const filename = filenameFromHeader(getHeader(event, "x-mayi-filename"));
  const declaredMediaType = String(getHeader(event, "content-type") ?? "").split(";", 1)[0] as ArtefactMediaType;
  if (!Number.isInteger(ordinal) || ordinal < 0 || ordinal >= 20) {
    throw createError({ statusCode: 422, statusMessage: "Artefact ordinal must be between 0 and 19" });
  }
  if (!filename || filename.length > 255) {
    throw createError({ statusCode: 422, statusMessage: "X-Mayi-Filename must contain 1 to 255 characters" });
  }
  if (!ARTEFACT_MEDIA_TYPES.includes(declaredMediaType)) {
    throw createError({ statusCode: 415, statusMessage: "Only PDF, PNG, JPEG, and WebP evidence is accepted" });
  }
  const declaredSize = Number(getHeader(event, "content-length") ?? 0);
  if (declaredSize > MAX_ARTEFACT_BYTES) {
    throw createError({ statusCode: 413, statusMessage: "Artefact exceeds 25 MiB" });
  }
  const body = await readRawBody(event, false);
  if (!body?.byteLength || body.byteLength > MAX_ARTEFACT_BYTES) {
    throw createError({ statusCode: 413, statusMessage: "Artefact is empty or exceeds 25 MiB" });
  }
  const mediaType = detectArtefactMediaType(body);
  if (!mediaType || mediaType !== declaredMediaType) {
    throw createError({ statusCode: 415, statusMessage: "Artefact bytes do not match the declared media type" });
  }

  const digest = await sha256(body);
  const payloadHash = await canonicalDigest({
    requestKey,
    ordinal,
    filename,
    mediaType,
    size: body.byteLength,
    sha256: digest,
  });
  const identityHash = await sha256(new TextEncoder().encode(JSON.stringify([
    auth.workspaceId,
    auth.agentId,
    requestKey,
    ordinal,
  ])));

  const reservation = await database().sql.begin(async (sql) => {
    const lockKey = `${auth.workspaceId}:${auth.agentId}:approval.request.artefact:${requestKey}:${ordinal}`;
    await sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
    const [existing] = await sql`
      select id, object_key, filename, media_type, size, sha256, state, upload_payload_hash
      from artefacts
      where workspace_id = ${auth.workspaceId}
        and agent_id = ${auth.agentId}
        and request_key = ${requestKey}
        and upload_ordinal = ${ordinal}
      for update
    `;
    if (existing) {
      if (existing.upload_payload_hash !== payloadHash) {
        throw createError({ statusCode: 409, statusMessage: "Idempotency key and ordinal were reused with different artefact content" });
      }
      return existing;
    }

    const id = createId();
    const objectKey = `${auth.workspaceId}/${auth.agentId}/staged/${identityHash}/${ordinal}`;
    const [created] = await sql`
      insert into artefacts (
        id, workspace_id, approval_id, agent_id, request_key, upload_ordinal,
        upload_payload_hash, expires_at, object_key, filename, media_type, size, sha256, state
      ) values (
        ${id}, ${auth.workspaceId}, null, ${auth.agentId}, ${requestKey}, ${ordinal},
        ${payloadHash}, now() + interval '24 hours', ${objectKey}, ${filename}, ${mediaType},
        ${body.byteLength}, ${digest}, 'UPLOADING'
      )
      returning id, object_key, filename, media_type, size, sha256, state, upload_payload_hash
    `;
    return created!;
  });

  if (reservation.state !== "READY") {
    const objectKey = String(reservation.object_key);
    const result = await objects().putIfAbsent(objectKey, body, mediaType);
    if (result === "exists") {
      const stored = await objects().get(objectKey);
      const storedDigest = await sha256(stored.bytes);
      if (
        stored.bytes.byteLength !== body.byteLength
        || storedDigest !== digest
        || (stored.mediaType !== undefined && stored.mediaType !== mediaType)
      ) {
        throw createError({ statusCode: 409, statusMessage: "The reserved artefact object does not match this upload" });
      }
    }
    await database().sql`
      update artefacts set state = 'READY'
      where id = ${reservation.id} and upload_payload_hash = ${payloadHash} and state = 'UPLOADING'
    `;
  }

  return {
    id: String(reservation.id),
    filename: String(reservation.filename),
    mediaType: String(reservation.media_type),
    size: Number(reservation.size),
    sha256: String(reservation.sha256),
  };
});
