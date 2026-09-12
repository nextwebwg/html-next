import { mergeConfig } from "vitest/config";

import baseConfig from "./vitest.config.js";

export default mergeConfig(baseConfig, {
  test: {
    env: { HTMLNEXT_CONSUMER_TEST: "1" },
    include: ["packages/declarative-components/tests/consumer-package.test.ts"],
    hookTimeout: 60_000,
    testTimeout: 60_000
  }
});
