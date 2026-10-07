import { readFileSync } from "node:fs";
import { relative, sep } from "node:path";

import { mergeConfig } from "vitest/config";
import { BaseSequencer, type TestSpecification } from "vitest/node";

import baseConfig from "./vitest.config.js";

const durations = JSON.parse(readFileSync(new URL("./tests/target-durations.json", import.meta.url), "utf8")) as Record<string, number>;

/**
 * CI shards each run within the 15-minute check budget. Vitest's hash order put several of the
 * longest parity specs on one shard, so shards are balanced by each spec's measured seconds instead.
 * ponytail: a hand-measured table, and unlisted specs count as 30 s; refresh it from a CI run when a
 * shard nears the budget.
 */
class DurationShardSequencer extends BaseSequencer {
  override async shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    const { index, count } = this.ctx.config.shard!;
    const seconds = (file: TestSpecification): number =>
      durations[relative(this.ctx.config.root, file.moduleId).split(sep).join("/")] ?? 30;
    const shards = Array.from({ length: count }, () => ({ seconds: 0, files: [] as TestSpecification[] }));
    // Longest first, each to the least loaded shard; path order breaks ties so every runner agrees.
    for (const file of [...files].sort((a, b) => seconds(b) - seconds(a) || a.moduleId.localeCompare(b.moduleId))) {
      const lightest = shards.reduce((least, shard) => shard.seconds < least.seconds ? shard : least);
      lightest.files.push(file);
      lightest.seconds += seconds(file);
    }
    return shards[index - 1]!.files;
  }
}

const config = mergeConfig(baseConfig, {
  test: {
    // Parity specs launch their own browsers. Keep one spec active at a time.
    fileParallelism: false,
    maxWorkers: 1,
    maxConcurrency: 1,
    env: { HTMLNEXT_TARGET_TEST: "1" },
    hookTimeout: 60_000,
    testTimeout: 60_000,
    sequence: { sequencer: DurationShardSequencer },
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
