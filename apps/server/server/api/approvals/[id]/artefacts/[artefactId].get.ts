import { createError, defineEventHandler, getRouterParam, setHeader } from "h3";
import { requireUserOrAgent } from "../../../../utils/auth";
import { database, objects } from "../../../../utils/runtime";

export default defineEventHandler(async (event) => {
  const auth = await requireUserOrAgent(event);
  const approvalId = getRouterParam(event, "id")!;
  const artefactId = getRouterParam(event, "artefactId")!;
  const rows = await database().sql`
    select f.object_key, f.filename, f.media_type from artefacts f join approvals a on a.id = f.approval_id
    where f.id = ${artefactId} and f.approval_id = ${approvalId} and f.workspace_id = ${auth.workspaceId}
      and (${auth.kind === "user"} or a.agent_id = ${auth.kind === "agent" ? auth.agentId : null}::uuid)
  `;
  const row = rows[0];
  if (!row) throw createError({ statusCode: 404, statusMessage: "Artefact not found" });
  const object = await objects().get(String(row.object_key));
  setHeader(event, "content-type", String(row.media_type));
  setHeader(event, "content-disposition", `inline; filename*=UTF-8''${encodeURIComponent(String(row.filename))}`);
  setHeader(event, "cache-control", "private, no-store");
  return object.bytes;
});
