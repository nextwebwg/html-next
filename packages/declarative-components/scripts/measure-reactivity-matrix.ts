import { createEffect, ReactiveScope } from "../src/reactivity.js";
import {
  type BenchmarkFramework,
  thirdPartyFrameworks,
} from "./reactivity-matrix-frameworks.js";

interface Workload {
  readonly iterations: number;
  readonly name: string;
  readonly run: (framework: BenchmarkFramework, iterations: number) => number;
}

const warmupSamples = 2;
const measuredSamples = 5;

function htmlNextFramework(): BenchmarkFramework {
  const scope = new ReactiveScope();
  const disposers = new Set<() => void>();
  let nextComputed = 0;
  let nextSignal = 0;
  let runningEffects = 0;
  const flush = (): void => {
    if (runningEffects === 0) scope.scheduler.flush();
  };
  return {
    name: "HTML Next",
    signal<T>(initialValue: T) {
      const name = `benchmarkSignal${nextSignal++}`;
      scope.set(name, initialValue as never);
      return {
        read: () => scope.get(name) as T,
        write(value) {
          scope.set(name, value as never);
          flush();
        },
      };
    },
    computed<T>(compute: () => T) {
      const name = `benchmarkComputed${nextComputed++}`;
      scope.set(name, undefined as never);
      const effect = createEffect(scope.scheduler, () => {
        runningEffects += 1;
        try { scope.set(name, compute() as never); }
        finally { runningEffects -= 1; }
      }, 0);
      const dispose = (): void => {
        effect.stop();
        disposers.delete(dispose);
      };
      disposers.add(dispose);
      flush();
      return { read: () => scope.get(name) as T };
    },
    effect(run) {
      const effect = createEffect(scope.scheduler, () => {
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

function measureFramework(create: () => BenchmarkFramework) {
  const name = create().name;
  const results: Record<string, number> = {};
  for (const workload of workloads) {
    const samples: number[] = [];
    for (let sample = 0; sample < warmupSamples + measuredSamples; sample += 1) {
      const value = workload.run(create(), workload.iterations);
      if (sample >= warmupSamples) samples.push(value);
    }
    results[workload.name] = median(samples);
  }
  return { name, workloads: results };
}

const attempted = [htmlNextFramework, ...thirdPartyFrameworks];
const measured: ReturnType<typeof measureFramework>[] = [];
const excluded: Array<{ readonly name: string; readonly reason: string }> = [];
for (const create of attempted) {
  const name = create().name;
  try { measured.push(measureFramework(create)); }
  catch (error) {
    if (name === "HTML Next") throw error;
    excluded.push({ name, reason: error instanceof Error ? error.message : String(error) });
  }
}

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
  matrix_checks_pass: ranked.length >= 11 ? 1 : 0,
  matrix_framework_count: attempted.length,
  matrix_third_party_count: thirdPartyFrameworks.length,
  matrix_ranked_count: ranked.length,
  matrix_excluded_count: excluded.length,
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
