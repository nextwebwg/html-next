import { describe, expect, it } from "vitest";

import {
  testSuite,
  type Computed,
  type ReactiveFramework,
  type Signal,
} from "reactive-framework-test-suite";

import { createEffect, ReactiveScope } from "../src/reactivity.js";

function htmlNextAdapter(): ReactiveFramework {
  const scope = new ReactiveScope();
  const owned = new Set<() => void>();
  let nextSignal = 0;
  let nextComputed = 0;
  let runningEffects = 0;

  const flushOutsideEffect = (): void => {
    if (runningEffects === 0) scope.scheduler.flush();
  };

  return {
    name: "HTML Next",
    signal<T>(initialValue: T): Signal<T> {
      const name = `suiteSignal${nextSignal++}`;
      scope.set(name, initialValue as never);
      return {
        read: () => scope.get(name) as T,
        write(value) {
          scope.set(name, value as never);
          flushOutsideEffect();
        },
      };
    },
    computed<T>(compute: () => T): Computed<T> {
      const name = `suiteComputed${nextComputed++}`;
      scope.set(name, undefined as never);
      const effect = createEffect(scope.scheduler, () => {
        runningEffects += 1;
        try { scope.set(name, compute() as never); }
        finally { runningEffects -= 1; }
      }, 0);
      const dispose = () => {
        effect.stop();
        owned.delete(dispose);
      };
      owned.add(dispose);
      flushOutsideEffect();
      return { read: () => scope.get(name) as T };
    },
    effect(run) {
      const effect = createEffect(scope.scheduler, () => {
        runningEffects += 1;
        try { return run(); }
        finally { runningEffects -= 1; }
      });
      const dispose = () => {
        effect.stop();
        owned.delete(dispose);
      };
      owned.add(dispose);
      flushOutsideEffect();
      return dispose;
    },
    run(run) {
      try { run(); }
      finally {
        for (const dispose of owned) dispose();
      }
    },
  };
}

const cycleCases = testSuite.find(({ section }) => section === "Cycle & Infinite Loop Detection")!;
const dynamicCases = testSuite.find(({ section }) => section === "Dynamic Dependencies")!;
const lifecycleCases = testSuite.find(({ section }) => section === "Effect Lifecycle")!;
const behavioralCases = testSuite.find(({ section }) => section === "Behavioral Differences")!;

function runCase(section: typeof cycleCases, name: string): void {
  const framework = htmlNextAdapter();
  framework.run(() => section.cases[name]!(framework));
}

describe("reactive-framework-test-suite cycle cases", () => {
  for (const name of [
    "#61 indirect cycle through effects",
    "#63 cycle from modifying a branch (dynamic cycle creation)",
    "#64 max iteration limit reached",
    "#221 three-effect cycle stays bounded",
  ]) {
    it(name, () => runCase(cycleCases, name));
  }

  it("#62 reports that an unconditional effect cycle is detected", () => {
    const framework = htmlNextAdapter();
    let result: unknown;
    framework.run(() => {
      result = behavioralCases.cases["#62 infinite loop in effect"]!(framework);
    });
    expect(result).toBe("cycle detected");
  });
});

describe("reactive-framework-test-suite dependency cases", () => {
  for (const name of [
    "#12 active dep triggers, inactive dep does not",
    "#13 switching branches deactivates old deps",
    "#198 effect discovers new branch deps",
    "#199 effect ignores inactive branch dep",
    "#200 independent dep tracking across effects with dynamic deps",
  ]) {
    it(name, () => runCase(dynamicCases, name));
  }
});

describe("reactive-framework-test-suite lifecycle cases", () => {
  for (const name of [
    "#35 effect runs callback immediately on creation",
    "#36 effect re-runs when dependency changes",
    "#38 effect cleanup fn called before each re-run",
    "#39 effect cleanup fn called on disposal",
    "#40 effect cleanup runs outside reactive evaluation context",
    "#108 effect self-dispose during execution is safe",
    "#110 double-dispose is safe",
    "#111 cleanup-triggered dispose prevents re-run",
    "#141 dispose during execution then continue: no re-run",
    "#143 destroyed effect not re-scheduled on later updates",
    "#216 effects fire in creation order on shared signal",
    "#217 new effect after dispose works normally",
    "#222 effect created inside cleanup tracks its own deps",
  ]) {
    it(name, () => runCase(lifecycleCases, name));
  }
});
