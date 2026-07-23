import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["apps/studio/**/*.e2e.test.ts"],
    exclude: ["**/dist/**", "**/dist-*/**", "**/node_modules/**"],
    fileParallelism: false,
    maxWorkers: 1,
    hookTimeout: 30_000,
    testTimeout: 45_000
  }
});
