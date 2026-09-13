import { mergeConfig } from "vitest/config";

import baseConfig from "./vitest.config.js";

export default mergeConfig(baseConfig, {
  test: {
    env: { HTMLNEXT_LOOMA_TEST: "1" },
    include: [
      "packages/declarative-components/tests/consumer-knit.test.ts",
      "packages/declarative-components/tests/consumer-loadops.test.ts",
      "packages/declarative-components/tests/looma-components.test.ts",
      "packages/declarative-components/tests/looma-css.test.ts",
      "packages/declarative-components/tests/looma-inventory.test.ts",
      "packages/declarative-components/tests/looma-layout.test.ts",
      "packages/declarative-components/tests/looma-package.test.ts",
      "packages/declarative-components/tests/migrate-stencil.test.ts",
      "packages/declarative-components/tests/package.test.ts"
    ],
    hookTimeout: 60_000,
    testTimeout: 60_000
  }
});
