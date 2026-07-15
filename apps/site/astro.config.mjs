import { defineConfig, fontProviders } from "astro/config";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  site: "https://mayi.sh",
  output: "static",
  trailingSlash: "never",
  devToolbar: { enabled: false },
  vite: {
    plugins: [tailwindcss()],
    // The deployed CSP is `default-src 'self'` with no `script-src`, so an inlined
    // <script> is blocked. Keep every script an external, same-origin asset.
    build: { assetsInlineLimit: 0 },
  },
  fonts: [
    {
      // Suisse Intl is a commercial face from Swiss Typefaces and needs a webfont
      // licence for each site that serves it — note that app.mayi.sh is a second
      // origin, not covered by whatever covers mayi.sh. Sources came from zero8-home;
      // the woff2s in packages/theme/fonts are converted from its OTFs, and live
      // there because the app serves the same face. Only the weights the site
      // actually sets are declared here — every variant listed gets an @font-face
      // and a preload, so an unused one is pure download.
      name: "Suisse Intl",
      cssVariable: "--font-suisse-intl",
      provider: fontProviders.local(),
      fallbacks: ["Helvetica Neue", "ui-sans-serif", "system-ui"],
      options: {
        variants: [
          { weight: 400, style: "normal", src: ["../../packages/theme/fonts/SuisseIntl-Regular.woff2"] },
          { weight: 500, style: "normal", src: ["../../packages/theme/fonts/SuisseIntl-Medium.woff2"] },
          { weight: 600, style: "normal", src: ["../../packages/theme/fonts/SuisseIntl-SemiBold.woff2"] },
        ],
      },
    },
    {
      // Mono is reserved for machine data — field names, literal values, digests,
      // code, the held clock. Geist is drawn to be neutral beside a Swiss grotesk,
      // so it reads as texture next to Suisse rather than as a second voice.
      name: "Geist Mono",
      cssVariable: "--font-geist-mono",
      provider: fontProviders.google(),
      weights: [400],
      fallbacks: ["ui-monospace", "monospace"],
    },
  ],
});
