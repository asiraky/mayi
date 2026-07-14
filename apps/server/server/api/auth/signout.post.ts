import { defineEventHandler } from "h3";
import { revokeSession } from "../../utils/auth";

export default defineEventHandler(async (event) => { await revokeSession(event); return { ok: true }; });
