import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["{apps,extensions,packages}/**/*.test.ts"],
    exclude: [
      "**/*.e2e.test.ts",
      "**/*.perf.test.ts",
      "**/dist/**",
      "**/dist-*/**",
      "**/node_modules/**"
    ],
    testTimeout: 10_000
  }
});
