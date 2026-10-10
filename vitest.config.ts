import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  resolve: {
    alias: [
      {
        find: /^@nextwebwg\/html-next\/(node-loader|server)$/,
        replacement: fileURLToPath(new URL("./packages/html-next/src/$1.ts", import.meta.url)),
      },
      {
        find: /^@nextwebwg\/html-next-converter$/,
        replacement: fileURLToPath(new URL("./packages/html-next-converter/src/index.ts", import.meta.url)),
      },
      {
        find: /^@nextwebwg\/html-next$/,
        replacement: fileURLToPath(new URL("./packages/html-next/src/index.ts", import.meta.url)),
      },
    ],
  },
  test: {
    exclude: ["**/dist/**", "**/node_modules/**"],
    include: ["packages/*/tests/**/*.test.ts", "tests/**/*.test.ts"],
    // Compiler/consumer fixtures spawn their own builds; cap workers to avoid CPU contention.
    maxWorkers: 2,
    testTimeout: 30_000,
  },
});
