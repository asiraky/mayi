import { defineEventHandler } from "h3";
import { requireUser } from "../../utils/auth";
import { database } from "../../utils/runtime";
export default defineEventHandler(async (event) => { const auth = await requireUser(event); return database().sql`select id, type, name, endpoint, mode, mapped_user_id, verified_at, active from forwarding_destinations where workspace_id = ${auth.workspaceId} order by created_at desc`; });
