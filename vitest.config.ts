import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts"],
    // PostgreSQL integration suites deliberately install fault-injection triggers.
    // Run files serially so those database-global fixtures cannot affect another suite.
    fileParallelism: false,
    coverage: { reporter: ["text", "json-summary"] },
  },
});
