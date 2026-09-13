import { mergeConfig } from "vitest/config";

import baseConfig from "./vitest.config.js";

export default mergeConfig(baseConfig, {
  test: {
    env: { HTMLNEXT_BROWSER_TEST: "1" },
    include: [
      "packages/declarative-components/tests/browser-loader.test.ts",
      "packages/declarative-components/tests/conformance.test.ts",
      "packages/html-forms/tests/forms.test.ts",
      "packages/declarative-components/tests/runtime.test.ts",
      "packages/declarative-components/tests/source-adapters.test.ts",
      "packages/declarative-components/tests/validity.test.ts"
    ],
    hookTimeout: 60_000,
    testTimeout: 60_000
  }
});
