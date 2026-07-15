import { defineNitroConfig } from "nitropack/config";
import { fileURLToPath } from "node:url";

const preset = process.env.NITRO_PRESET ?? "node-server";
const apiCorsHeaders = [
  "authorization",
  "content-type",
  "idempotency-key",
  "x-consumer-key",
  "x-mayi-filename",
  "x-mayi-native",
  "x-workspace-id",
].join(", ");

export default defineNitroConfig({
  preset,
  compatibilityDate: "2026-07-14",
  srcDir: "server",
  // Vercel consumes Build Output API artefacts from the repository root.
  ...(preset === "vercel" ? { output: { dir: fileURLToPath(new URL("../../.vercel/output", import.meta.url)) } } : {}),
  publicAssets: [{ dir: fileURLToPath(new URL("../web/dist", import.meta.url)), maxAge: 3600 }],
  routeRules: {
    "/api/**": {
      headers: {
        "cache-control": "no-store",
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS",
        // Authorization is a CORS non-wildcard request header and must be named
        // explicitly even when the bearer request omits credentials.
        "access-control-allow-headers": apiCorsHeaders,
        "access-control-max-age": "600",
      },
    },
    "/.well-known/**": { cors: true },
  },
  runtimeConfig: {
    ...(process.env.DATABASE_URL ? { databaseUrl: process.env.DATABASE_URL } : {}),
    publicOrigin: process.env.PUBLIC_ORIGIN ?? "http://localhost:3000",
  },
});
