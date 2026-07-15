import { createId, sha256 } from "@mayi/contracts";
import { createError, defineEventHandler, getHeader, getQuery, getRouterParam, readRawBody } from "h3";
import { requireAgent } from "../../../utils/auth";
import { database } from "../../../utils/runtime";
import { objects } from "../../../utils/runtime";

const allowed = new Set(["application/pdf", "image/png", "image/jpeg", "image/webp"]);
const maximum = 25 * 1024 * 1024;

export default defineEventHandler(async (event) => {
  const auth = await requireAgent(event, "approval:create");
  const approvalId = getRouterParam(event, "id")!;
  const filename = String(getQuery(event).filename ?? "").trim();
  const mediaType = String(getHeader(event, "content-type") ?? "").split(";", 1)[0]!;
  if (!filename || filename.length > 255) throw createError({ statusCode: 422, statusMessage: "A valid filename query parameter is required" });
  if (!allowed.has(mediaType)) throw createError({ statusCode: 415, statusMessage: "Only PDF, PNG, JPEG, and WebP evidence is accepted" });
  const declared = Number(getHeader(event, "content-length") ?? 0);
  if (declared > maximum) throw createError({ statusCode: 413, statusMessage: "Artefact exceeds 25 MiB" });
  const body = await readRawBody(event, false);
  if (!body?.byteLength || body.byteLength > maximum) throw createError({ statusCode: 413, statusMessage: "Artefact is empty or exceeds 25 MiB" });
  const draft = await database().sql`select 1 from approvals where id = ${approvalId} and workspace_id = ${auth.workspaceId} and agent_id = ${auth.agentId} and state = 'DRAFT'`;
  if (!draft.length) throw createError({ statusCode: 409, statusMessage: "Only the owning agent may upload to a draft" });
  const id = createId();
  const objectKey = `${auth.workspaceId}/${approvalId}/${id}`;
  const digest = await sha256(body);
  await objects().putImmutable(objectKey, body, mediaType);
  await database().sql`
    insert into artefacts (id, workspace_id, approval_id, agent_id, object_key, filename, media_type, size, sha256)
    values (${id}, ${auth.workspaceId}, ${approvalId}, ${auth.agentId}, ${objectKey}, ${filename}, ${mediaType}, ${body.byteLength}, ${digest})
  `;
  return { id, filename, mediaType, size: body.byteLength, sha256: digest };
});
