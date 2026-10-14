import { mergeConfig } from "vitest/config";

import baseConfig from "./vitest.config.js";

const config = mergeConfig(baseConfig, {
  test: {
    // Playwright specs launch their own browsers. Keep one spec active at a time.
    fileParallelism: false,
    maxWorkers: 1,
    maxConcurrency: 1,
    env: { HTMLNEXT_BROWSER_TEST: "1" },
    hookTimeout: 60_000,
    testTimeout: 60_000
  }
});

// mergeConfig concatenates arrays, so replace the base Node-test include list explicitly.
config.test!.include = [
  "packages/htmlkit/tests/browser.test.ts",
  "packages/htmlkit/tests/client-navigation.test.ts",
  "packages/html-next/tests/browser-loader.test.ts",
  "packages/html-next/tests/conformance.test.ts",
  "packages/html-next/tests/forms.test.ts",
  "packages/html-next/tests/runtime.test.ts",
  "packages/html-next/tests/sanitize.test.ts",
  "packages/html-next/tests/source-adapters.test.ts",
  "packages/html-next/tests/server-hydration.test.ts",
  "packages/html-next/tests/server-continuation.test.ts",
  "packages/html-next/tests/validity.test.ts",
  "packages/html-next/tests/pantry-app.test.ts",
  "packages/html-next/tests/platform-scoping.test.ts",
];

export default config;
