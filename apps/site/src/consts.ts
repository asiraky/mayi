/**
 * Where "Open app" and "Start free" point.
 *
 * Hardcoding https://app.mayi.sh meant every click during local development left the
 * dev site and landed on production. In `astro dev` this falls back to the Vite dev
 * server the app runs on (see apps/web/vite.config.ts); a build still points at
 * production unless told otherwise.
 *
 * PUBLIC_APP_URL overrides both. It has to carry the PUBLIC_ prefix to reach the
 * client bundle, and it matters beyond dev: a self-hoster serving the app on their
 * own domain sets it at build time rather than patching the markup.
 */
export const APP_URL =
  import.meta.env.PUBLIC_APP_URL ?? (import.meta.env.DEV ? "http://localhost:5173" : "https://app.mayi.sh");
