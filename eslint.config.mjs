import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/.astro/**",
      "**/.nitro/**",
      "**/.output/**",
      "**/.vercel/**",
      "**/dist/**",
      "**/node_modules/**",
      "apps/site/**/*.astro",
      // Copied verbatim from packages/theme by each app's sync:theme script; the
      // original is linted at source, so linting the copies just triples the report.
      "apps/*/public/theme.js",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Runs in the browser before any bundler sees it, so it is plain ES5 with the
    // DOM globals rather than a module.
    files: ["packages/theme/theme.js"],
    languageOptions: {
      globals: { window: "readonly", document: "readonly", localStorage: "readonly" },
    },
  },
);
