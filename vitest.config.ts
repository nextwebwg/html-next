import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  resolve: {
    alias: [
      {
        find: /^@nextwebwg\/declarative-components$/,
        replacement: fileURLToPath(new URL("./packages/declarative-components/src/index.ts", import.meta.url)),
      },
      {
        find: /^@nextwebwg\/html-forms$/,
        replacement: fileURLToPath(new URL("./packages/html-forms/src/index.ts", import.meta.url)),
      },
    ],
  },
  test: {
    exclude: ["**/dist/**", "**/node_modules/**"],
    include: ["packages/*/tests/**/*.test.ts", "tests/**/*.test.ts"],
    testTimeout: 30_000,
  },
});
