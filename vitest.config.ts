import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  test: {
    exclude: ["**/dist/**", "**/node_modules/**"],
    include: ["packages/*/tests/**/*.test.ts", "tests/**/*.test.ts"],
    testTimeout: 30_000,
  },
});
