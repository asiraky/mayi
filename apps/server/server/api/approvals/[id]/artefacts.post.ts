import { createId, sha256 } from "@mayi/contracts";
import { createError, defineEventHandler, getHeader, getQuery, getRouterParam } from "h3";
import { requireAgent } from "../../../utils/auth";
import {
  ARTEFACT_MEDIA_TYPES,
  MAX_ARTEFACT_BYTES,
  detectArtefactMediaType,
  type ArtefactMediaType,
} from "../../../utils/artefacts";
import { readBoundedBody } from "../../../utils/http";
import { database, objects } from "../../../utils/runtime";

export default defineEventHandler(async (event) => {
  const auth = await requireAgent(event, "approval:create");
  const approvalId = getRouterParam(event, "id")!;
  const filename = String(getQuery(event).filename ?? "").trim();
  const declaredMediaType = String(getHeader(event, "content-type") ?? "").split(";", 1)[0] as ArtefactMediaType;
  if (!filename || filename.length > 255) throw createError({ statusCode: 422, statusMessage: "A valid filename query parameter is required" });
  if (!ARTEFACT_MEDIA_TYPES.includes(declaredMediaType)) throw createError({ statusCode: 415, statusMessage: "Only PDF, PNG, JPEG, and WebP evidence is accepted" });
  const body = await readBoundedBody(event, MAX_ARTEFACT_BYTES, "Artefact exceeds 25 MiB");
  if (!body?.byteLength || body.byteLength > MAX_ARTEFACT_BYTES) throw createError({ statusCode: 413, statusMessage: "Artefact is empty or exceeds 25 MiB" });
  const mediaType = detectArtefactMediaType(body);
  if (!mediaType || mediaType !== declaredMediaType) {
    throw createError({ statusCode: 415, statusMessage: "Artefact bytes do not match the declared media type" });
  }
  const id = createId();
  const objectKey = `${auth.workspaceId}/${approvalId}/${id}`;
  const digest = await sha256(body);
  await database().sql.begin(async (sql) => {
    const draft = await sql`
      select 1 from approvals
      where id = ${approvalId} and workspace_id = ${auth.workspaceId}
        and agent_id = ${auth.agentId} and state = 'DRAFT'
      for update
    `;
    if (!draft.length) throw createError({ statusCode: 409, statusMessage: "Only the owning agent may upload to a draft" });
    await sql`
      insert into artefacts (
        id, workspace_id, approval_id, agent_id, expires_at, object_key,
        filename, media_type, size, sha256, state
      ) values (
        ${id}, ${auth.workspaceId}, ${approvalId}, ${auth.agentId}, now() + interval '1 hour',
        ${objectKey}, ${filename}, ${mediaType}, ${body.byteLength}, ${digest}, 'UPLOADING'
      )
    `;
  });

  const store = objects();
  try {
    await store.putImmutable(objectKey, body, mediaType);
    const promoted = await database().sql.begin(async (sql) => {
      const rows = await sql`
        select a.state as approval_state, f.state as artefact_state
        from approvals a join artefacts f on f.approval_id = a.id
        where a.id = ${approvalId} and a.workspace_id = ${auth.workspaceId}
          and a.agent_id = ${auth.agentId} and f.id = ${id}
        for update of a, f
      `;
      const current = rows[0];
      if (!current || current.approval_state !== "DRAFT" || current.artefact_state !== "UPLOADING") {
        if (current?.artefact_state === "UPLOADING") await sql`update artefacts set state = 'DELETING' where id = ${id}`;
        return false;
      }
      await sql`update artefacts set state = 'READY', expires_at = null where id = ${id} and state = 'UPLOADING'`;
      return true;
    });
    if (!promoted) {
      await store.delete(objectKey);
      await database().sql`delete from artefacts where id = ${id} and state = 'DELETING'`;
      throw createError({ statusCode: 409, statusMessage: "The draft changed while evidence was uploading" });
    }
  } catch (error) {
    await database().sql`update artefacts set state = 'DELETING' where id = ${id} and state = 'UPLOADING'`.catch(() => undefined);
    await store.delete(objectKey).catch(() => undefined);
    await database().sql`delete from artefacts where id = ${id} and state = 'DELETING'`.catch(() => undefined);
    throw error;
  }
  return { id, filename, mediaType, size: body.byteLength, sha256: digest };
});
