import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@nextwebwg/declarative-components": fileURLToPath(
        new URL("../declarative-components/src/index.ts", import.meta.url),
      ),
      "@nextwebwg/html-forms": fileURLToPath(
        new URL("../html-forms/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 30_000,
  },
});
