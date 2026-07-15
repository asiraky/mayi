import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "callback-state": "src/callback-state.ts",
    "webhook-verifier": "src/webhook-verifier.ts",
    cli: "src/cli.ts",
  },
  format: ["esm"],
  target: "es2022",
  platform: "neutral",
  bundle: true,
  clean: true,
  dts: true,
  sourcemap: true,
  splitting: false,
  external: ["jose"],
  noExternal: ["@mayi/contracts", "nanoid", "zod"],
  esbuildOptions(options) {
    options.sourcesContent = false;
  },
});
