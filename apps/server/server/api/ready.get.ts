import { createError, defineEventHandler } from "h3";
import { database } from "../utils/runtime";
export default defineEventHandler(async () => {
  try { await database().sql`select 1`; return { status: "ready" }; }
  catch { throw createError({ statusCode: 503, statusMessage: "Not ready" }); }
});
