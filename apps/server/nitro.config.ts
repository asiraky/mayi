import { defineNitroConfig } from "nitropack/config";
import { fileURLToPath } from "node:url";

const preset = process.env.NITRO_PRESET ?? "node-server";

export default defineNitroConfig({
  preset,
  compatibilityDate: "2026-07-14",
  srcDir: "server",
  // Vercel consumes Build Output API artefacts from the repository root.
  ...(preset === "vercel" ? { output: { dir: fileURLToPath(new URL("../../.vercel/output", import.meta.url)) } } : {}),
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
