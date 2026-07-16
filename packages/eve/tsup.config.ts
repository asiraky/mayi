import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts" },
  format: ["esm"],
  target: "es2022",
  platform: "neutral",
  bundle: true,
  clean: true,
  dts: true,
  sourcemap: true,
  splitting: false,
  external: ["@mayiapp/sdk", "eve"],
  esbuildOptions(options) {
    options.sourcesContent = false;
  },
});
