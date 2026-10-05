import { mergeConfig } from "vitest/config";

import baseConfig from "./vitest.config.js";

const config = mergeConfig(baseConfig, {
  test: {
    // Parity specs launch their own browsers. Keep one spec active at a time.
    fileParallelism: false,
    maxWorkers: 1,
    maxConcurrency: 1,
    env: { HTMLNEXT_TARGET_TEST: "1" },
    hookTimeout: 60_000,
    testTimeout: 60_000
  }
});

// mergeConfig concatenates arrays, so do not retain the base Node-test include list.
config.test!.include = [
  "packages/html-next/tests/targets.test.ts",
  "packages/html-next/tests/target-runtime.test.ts",
  "packages/html-next/tests/vue-parity.test.ts",
  "packages/html-next-converter/tests/vue-*-parity.test.ts",
  "packages/html-next-converter/tests/react-*-parity.test.ts",
  "packages/html-next-converter/tests/svelte-*-parity.test.ts",
  "packages/html-next-converter/tests/library-distribution.test.ts",
  "packages/html-next-unplugin/tests/framework.test.ts",
];

export default config;
