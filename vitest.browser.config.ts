import { mergeConfig } from "vitest/config";

import baseConfig from "./vitest.config.js";

const config = mergeConfig(baseConfig, {
  test: {
    env: { HTMLNEXT_BROWSER_TEST: "1" },
    hookTimeout: 60_000,
    testTimeout: 60_000
  }
});

// mergeConfig concatenates arrays, so replace the base Node-test include list explicitly.
config.test!.include = [
  "packages/declarative-components/tests/browser-loader.test.ts",
  "packages/declarative-components/tests/conformance.test.ts",
  "packages/html-forms/tests/forms.test.ts",
  "packages/declarative-components/tests/runtime.test.ts",
  "packages/declarative-components/tests/source-adapters.test.ts",
  "packages/declarative-components/tests/validity.test.ts",
  "packages/declarative-components/tests/component-library-smoke.test.ts",
  "packages/declarative-components/tests/platform-scoping.test.ts",
];

export default config;
