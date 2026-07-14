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
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
);
