import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    // e2e tests spawn child processes and bind ports; give them room.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
