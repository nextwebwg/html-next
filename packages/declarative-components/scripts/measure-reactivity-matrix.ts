import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  createComputed,
  createEffect,
  createSignal,
  ReactiveScheduler,
} from "../src/reactivity.js";
import {
  type BenchmarkFramework,
  thirdPartyFrameworks,
} from "./reactivity-matrix-frameworks.js";

interface Workload {
  readonly iterations: number;
  readonly name: string;
  readonly run: (framework: BenchmarkFramework, iterations: number) => number;
}

interface FrameworkResult {
  readonly name: string;
  readonly workloads: Record<string, number>;
}

const warmupSamples = 2;
const measuredSamples = 5;
const processSamples = 5;
// Longer timed sections reduce scheduler noise; stability is still established by comparing
// independent fresh-process matrix runs rather than these repeated in-process samples.
const iterationScaleArgument = process.argv.find((argument) =>
  argument.startsWith("--iteration-scale="));
const iterationScale = iterationScaleArgument === undefined
  ? 1
  : Number(iterationScaleArgument.slice("--iteration-scale=".length));
if (!Number.isSafeInteger(iterationScale) || iterationScale < 1) {
  throw new Error("Iteration scale must be a positive integer.");
}

function htmlNextFramework(): BenchmarkFramework {
  const scheduler = new ReactiveScheduler();
  const disposers = new Set<() => void>();
  let runningEffects = 0;
  const flush = (): void => {
    if (runningEffects === 0) scheduler.flush();
  };
  return {
    name: "HTML Next",
    signal<T>(initialValue: T) {
      const signal = createSignal<T>(initialValue);
      return {
        read: () => signal.get(),
        write(value: T) {
          signal.set(value);
          flush();
        },
      };
    },
    computed<T>(compute: () => T) {
      const effect = createComputed<T>(scheduler, compute);
      const dispose = (): void => {
        effect.stop();
        disposers.delete(dispose);
      };
      disposers.add(dispose);
      return { read: () => effect.get() };
    },
    effect(run) {
      const effect = createEffect(scheduler, () => {
        runningEffects += 1;
        try { return run(); }
        finally { runningEffects -= 1; }
      });
      const dispose = (): void => {
        effect.stop();
        disposers.delete(dispose);
      };
      disposers.add(dispose);
      flush();
      return dispose;
    },
    run(run) {
      try { run(); }
      finally {
        for (const dispose of disposers) dispose();
      }
    },
  };
}

function time(run: () => number, expected: number, iterations: number): number {
  const start = process.hrtime.bigint();
  const actual = run();
  const elapsed = process.hrtime.bigint() - start;
  if (actual !== expected) throw new Error(`Expected ${expected}, received ${actual}.`);
  return Number(elapsed) / iterations;
}

const workloads: readonly Workload[] = [
  {
    name: "signal-write-read",
    iterations: 50_000,
    run(framework, iterations) {
      let duration = 0;
      framework.run(() => {
        const value = framework.signal(0);
        duration = time(() => {
          let current = 0;
          for (let index = 1; index <= iterations; index += 1) {
            value.write(index);
            current = value.read();
          }
          return current;
        }, iterations, iterations);
      });
      return duration;
    },
  },
  {
    name: "effect-propagation",
    iterations: 10_000,
    run(framework, iterations) {
      let duration = 0;
      framework.run(() => {
        const value = framework.signal(0);
        let observed = -1;
        const dispose = framework.effect(() => { observed = value.read(); });
        duration = time(() => {
          for (let index = 1; index <= iterations; index += 1) value.write(index);
          return observed;
        }, iterations, iterations);
        dispose();
      });
      return duration;
    },
  },
  {
    name: "computed-chain",
    iterations: 5_000,
    run(framework, iterations) {
      let duration = 0;
      framework.run(() => {
        const source = framework.signal(0);
        let current = framework.computed(() => source.read() + 1);
        for (let depth = 1; depth < 10; depth += 1) {
          const previous = current;
          current = framework.computed(() => previous.read() + 1);
        }
        let observed = -1;
        const dispose = framework.effect(() => { observed = current.read(); });
        duration = time(() => {
          for (let index = 1; index <= iterations; index += 1) source.write(index);
          return observed;
        }, iterations + 10, iterations);
        dispose();
      });
      return duration;
    },
  },
  {
    name: "diamond",
    iterations: 5_000,
    run(framework, iterations) {
      let duration = 0;
      framework.run(() => {
        const source = framework.signal(0);
        const left = framework.computed(() => source.read() + 1);
        const right = framework.computed(() => source.read() * 2);
        const joined = framework.computed(() => left.read() + right.read());
        let observed = -1;
        const dispose = framework.effect(() => { observed = joined.read(); });
        duration = time(() => {
          for (let index = 1; index <= iterations; index += 1) source.write(index);
          return observed;
        }, iterations * 3 + 1, iterations);
        dispose();
      });
      return duration;
    },
  },
  {
    name: "dynamic-dependencies",
    iterations: 2_000,
    run(framework, iterations) {
      let duration = 0;
      framework.run(() => {
        const chooseLeft = framework.signal(true);
        const left = framework.signal(0);
        const right = framework.signal(0);
        const selected = framework.computed(() => chooseLeft.read() ? left.read() : right.read());
        let observed = -1;
        const dispose = framework.effect(() => { observed = selected.read(); });
        duration = time(() => {
          for (let index = 1; index <= iterations; index += 1) {
            const useLeft = index % 2 === 0;
            chooseLeft.write(useLeft);
            if (useLeft) left.write(index);
            else right.write(index);
          }
          return observed;
        }, iterations, iterations);
        dispose();
      });
      return duration;
    },
  },
  {
    name: "fan-out-32",
    iterations: 1_000,
    run(framework, iterations) {
      let duration = 0;
      framework.run(() => {
        const source = framework.signal(0);
        const observed = Array.from({ length: 32 }, () => -1);
        const disposers = observed.map((_, index) => framework.effect(() => {
          observed[index] = source.read();
        }));
        duration = time(() => {
          for (let index = 1; index <= iterations; index += 1) source.write(index);
          return observed[0]! + observed[31]!;
        }, iterations * 2, iterations);
        for (const dispose of disposers) dispose();
      });
      return duration;
    },
  },
];

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)]!;
}

function geometricMean(values: readonly number[]): number {
  return Math.exp(values.reduce((sum, value) => sum + Math.log(value), 0) / values.length);
}

function measureFramework(create: () => BenchmarkFramework): FrameworkResult {
  const name = create().name;
  const results: Record<string, number> = {};
  for (const workload of workloads) {
    const samples: number[] = [];
    for (let sample = 0; sample < warmupSamples + measuredSamples; sample += 1) {
      const value = workload.run(create(), workload.iterations * iterationScale);
      if (sample >= warmupSamples) samples.push(value);
    }
    results[workload.name] = median(samples);
  }
  return { name, workloads: results };
}

function aggregateFramework(samples: readonly FrameworkResult[]): FrameworkResult {
  const first = samples[0];
  if (first === undefined) throw new Error("Cannot aggregate an empty framework sample set.");
  return {
    name: first.name,
    workloads: Object.fromEntries(workloads.map(({ name }) => [
      name,
      median(samples.map((sample) => sample.workloads[name]!)),
    ])),
  };
}

const attempted = [htmlNextFramework, ...thirdPartyFrameworks];
const frameworkIndexArgument = process.argv.find((argument) =>
  argument.startsWith("--framework-index="));

if (frameworkIndexArgument !== undefined) {
  const frameworkIndex = Number(frameworkIndexArgument.slice("--framework-index=".length));
  const create = attempted[frameworkIndex];
  if (create === undefined) throw new Error(`Unknown framework index ${frameworkIndex}.`);
  const result = measureFramework(create);
  process.stdout.write(`${JSON.stringify(result)}\n`, () => process.exit(0));
} else {
  const script = fileURLToPath(import.meta.url);
  const measureInFreshProcess = (frameworkIndex: number): FrameworkResult => {
    const output = execFileSync(process.execPath, [
      "--import",
      "tsx",
      script,
      `--framework-index=${frameworkIndex}`,
      ...(iterationScaleArgument === undefined ? [] : [iterationScaleArgument]),
    ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return JSON.parse(output) as FrameworkResult;
  };
  const childError = (error: unknown): string => {
    if (typeof error === "object" && error !== null && "stderr" in error) {
      const stderr = String((error as { readonly stderr: unknown }).stderr);
      const message = stderr.match(/Error: Expected[^\n]*/)?.[0];
      if (message !== undefined) return message;
    }
    return error instanceof Error ? error.message : String(error);
  };
  const rotation = process.pid % attempted.length;
  const samples = new Map<number, FrameworkResult[]>();
  const htmlNextControlSamples: FrameworkResult[] = [];
  const excluded: Array<{ readonly name: string; readonly reason: string }> = [];
  const excludedIndexes = new Set<number>();
  for (let processSample = 0; processSample < processSamples; processSample += 1) {
    const roundRotation = (rotation + processSample * 5) % attempted.length;
    const measurementOrder = Array.from({ length: attempted.length }, (_, offset) =>
      (roundRotation + offset) % attempted.length);
    for (const frameworkIndex of measurementOrder) {
      if (excludedIndexes.has(frameworkIndex)) continue;
      const name = attempted[frameworkIndex]!().name;
      try {
        const result = measureInFreshProcess(frameworkIndex);
        const frameworkSamples = samples.get(frameworkIndex) ?? [];
        frameworkSamples.push(result);
        samples.set(frameworkIndex, frameworkSamples);
      } catch (error) {
        if (name === "HTML Next") throw error;
        excludedIndexes.add(frameworkIndex);
        samples.delete(frameworkIndex);
        excluded.push({ name, reason: childError(error) });
      }
    }
    htmlNextControlSamples.push(measureInFreshProcess(0));
  }

  const measured = [...samples.values()].map(aggregateFramework);
  const htmlNextControl = aggregateFramework(htmlNextControlSamples);
  const htmlNextMeasured = measured.find(({ name }) => name === "HTML Next")!;
  const aaRelativeSpreads = Object.fromEntries(workloads.map(({ name }) => {
    const ratio = htmlNextControl.workloads[name]! / htmlNextMeasured.workloads[name]!;
    return [name, Math.max(ratio, 1 / ratio) - 1];
  }));
  const aaScoreRatio = geometricMean(workloads.map(({ name }) =>
    htmlNextControl.workloads[name]! / htmlNextMeasured.workloads[name]!));
  const aaScoreRelativeSpread = Math.max(aaScoreRatio, 1 / aaScoreRatio) - 1;
  const revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {
    encoding: "utf8",
  }).trim() === "" ? 0 : 1;
  const bestByWorkload = Object.fromEntries(workloads.map(({ name }) => [
    name,
    Math.min(...measured.map((framework) => framework.workloads[name]!)),
  ]));
  const ranked = measured.map((framework) => ({
    ...framework,
    score: geometricMean(workloads.map(({ name }) =>
      framework.workloads[name]! / bestByWorkload[name]!
    )),
  })).sort((left, right) => left.score - right.score);
  const htmlNextIndex = ranked.findIndex(({ name }) => name === "HTML Next");
  const htmlNext = ranked[htmlNextIndex]!;
  const report = {
    matrix_checks_pass: ranked.length >= 11 && aaScoreRelativeSpread <= 0.05 ? 1 : 0,
    matrix_framework_count: attempted.length,
    matrix_third_party_count: thirdPartyFrameworks.length,
    matrix_ranked_count: ranked.length,
    matrix_excluded_count: excluded.length,
    matrix_process_isolation: 1,
    matrix_process_samples_per_framework: processSamples,
    matrix_rotation: rotation,
    matrix_revision: revision,
    matrix_revision_dirty: dirty,
    matrix_node_version: process.version,
    matrix_platform: `${process.platform}-${process.arch}`,
    matrix_aa_score_relative_spread: aaScoreRelativeSpread,
    matrix_aa_max_relative_spread: Math.max(...Object.values(aaRelativeSpreads)),
    matrix_aa_workloads_relative_spread: aaRelativeSpreads,
    html_next_matrix_rank: htmlNextIndex + 1,
    html_next_matrix_score: htmlNext.score,
    ...Object.fromEntries(Object.entries(htmlNext.workloads).map(([name, value]) => [
      `html_next_${name.replaceAll("-", "_")}_ns`, value,
    ])),
    matrix: ranked.map((framework, index) => ({
      name: framework.name,
      rank: index + 1,
      score: framework.score,
      workloads_ns_per_iteration: framework.workloads,
    })),
    excluded,
  };

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`, () => process.exit(0));
}
