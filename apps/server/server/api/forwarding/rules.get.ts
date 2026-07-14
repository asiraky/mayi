import { defineEventHandler } from "h3";
import { requireUser } from "../../utils/auth";
import { database } from "../../utils/runtime";
export default defineEventHandler(async (event) => { const auth = await requireUser(event); return database().sql`select r.*, d.name as destination_name, d.mode from forwarding_rules r join forwarding_destinations d on d.id = r.destination_id where r.workspace_id = ${auth.workspaceId} order by r.created_at desc`; });
