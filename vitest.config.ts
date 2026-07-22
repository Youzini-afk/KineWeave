import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["{apps,extensions,packages}/**/*.test.ts"],
    exclude: ["**/dist/**", "**/node_modules/**"],
    testTimeout: 10_000
  }
});
