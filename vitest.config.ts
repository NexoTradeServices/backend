import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    globalSetup: ["tests/global-setup.ts"],
    setupFiles: ["tests/setup-env.ts"],
    // One database, one writer: these tests migrate, truncate and reset
    // sequences, so they must not run beside each other.
    fileParallelism: false,
    // `prisma migrate deploy` inside a test is slower than a query.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
