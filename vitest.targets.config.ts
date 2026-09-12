import { mergeConfig } from "vitest/config";

import baseConfig from "./vitest.config.js";

export default mergeConfig(baseConfig, {
  test: {
    env: { HTMLNEXT_TARGET_TEST: "1" },
    include: [
      "packages/declarative-components/tests/targets.test.ts",
      "packages/declarative-components/tests/target-runtime.test.ts"
    ],
    hookTimeout: 60_000,
    testTimeout: 60_000
  }
});
