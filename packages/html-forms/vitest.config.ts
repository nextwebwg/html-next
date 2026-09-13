import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    env: { HTMLNEXT_BROWSER_TEST: "1" },
    include: ["tests/**/*.test.ts"],
    hookTimeout: 60_000,
    testTimeout: 60_000,
  },
});
