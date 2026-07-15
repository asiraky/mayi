import { createError, getHeader, type H3Event } from "h3";
import { timingSafeEqual } from "./crypto";

export function requireCronSecret(event: H3Event): void {
  const expected = process.env.CRON_SECRET ?? "";
  const supplied = getHeader(event, "authorization")?.replace(/^Bearer /, "") ?? "";
  if (!expected || !timingSafeEqual(expected, supplied)) {
    throw createError({ statusCode: 401, statusMessage: "Internal authentication failed" });
  }
}
