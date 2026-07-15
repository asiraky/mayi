import { defineEventHandler, getRequestURL, setHeader, setResponseStatus } from "h3";

const ALLOWED_HEADERS = [
  "authorization",
  "content-type",
  "idempotency-key",
  "x-consumer-key",
  "x-mayi-filename",
  "x-mayi-native",
  "x-workspace-id",
].join(", ");

export default defineEventHandler((event) => {
  if (event.method !== "OPTIONS" || !getRequestURL(event).pathname.startsWith("/api/")) return;
  setHeader(event, "access-control-allow-origin", "*");
  setHeader(event, "access-control-allow-methods", "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS");
  setHeader(event, "access-control-allow-headers", ALLOWED_HEADERS);
  setHeader(event, "access-control-max-age", 600);
  setResponseStatus(event, 204);
  return null;
});
