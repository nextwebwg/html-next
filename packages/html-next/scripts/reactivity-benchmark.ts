import * as htmlNext from "../src/reactivity.js";

export interface BenchmarkSignal<T> {
  readonly read: () => T;
  readonly write: (value: T) => void;
}

export interface BenchmarkComputed<T> {
  readonly read: () => T;
}

export interface BenchmarkFramework {
  readonly name: string;
  readonly signal: <T>(initialValue: T) => BenchmarkSignal<T>;
  readonly computed: <T>(compute: () => T) => BenchmarkComputed<T>;
  readonly effect: (run: () => void | (() => void)) => () => void;
  readonly run: (run: () => void) => void;
}

interface Workload {
  readonly iterations: number;
  readonly name: string;
  readonly run: (framework: BenchmarkFramework, iterations: number) => number;
}

export interface FrameworkResult {
  readonly name: string;
  readonly workloads: Record<string, number>;
}

const warmupSamples = 2;
const measuredSamples = 5;

export function htmlNextFramework(runtime: typeof import("../src/reactivity.js") = htmlNext): BenchmarkFramework {
  const { createComputed, createEffect, createSignal, ReactiveScheduler } = runtime;
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

export const workloads: readonly Workload[] = [
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

export function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)]!;
}

export function geometricMean(values: readonly number[]): number {
  return Math.exp(values.reduce((sum, value) => sum + Math.log(value), 0) / values.length);
}

export function measureFramework(create: () => BenchmarkFramework, iterationScale = 1): FrameworkResult {
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

export function aggregateFramework(samples: readonly FrameworkResult[]): FrameworkResult {
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

