import { defineNitroConfig } from "nitropack/config";
import { fileURLToPath } from "node:url";

export default defineNitroConfig({
  preset: process.env.NITRO_PRESET ?? "node-server",
  compatibilityDate: "2026-07-14",
  srcDir: "server",
  publicAssets: [{ dir: fileURLToPath(new URL("../web/dist", import.meta.url)), maxAge: 3600 }],
  routeRules: {
    "/api/**": { cors: true, headers: { "cache-control": "no-store" } },
    "/.well-known/**": { cors: true },
  },
  runtimeConfig: {
    databaseUrl: process.env.DATABASE_URL,
    publicOrigin: process.env.PUBLIC_ORIGIN ?? "http://localhost:3000",
  },
});
