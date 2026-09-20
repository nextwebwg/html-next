import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { evaluate } from "../src/expression.js";
import {
  createComputed,
  createEffect,
  createSignal,
  ReactiveScope,
} from "../src/reactivity.js";

describe("reactive scope", () => {
  it("leaves unobserved computed values unevaluated until they are read", () => {
    const scheduler = new ReactiveScope().scheduler;
    const source = createSignal(0);
    let runs = 0;
    const doubled = createComputed(scheduler, () => {
      runs += 1;
      return source.get() * 2;
    });

    source.set(1);
    source.set(2);
    scheduler.flush();
    assert.equal(runs, 0);

    assert.equal(doubled.get(), 4);
    assert.equal(doubled.get(), 4);
    assert.equal(runs, 1);

    source.set(3);
    scheduler.flush();
    assert.equal(runs, 1);
    assert.equal(doubled.get(), 6);
    assert.equal(runs, 2);
  });

  it("keeps named scope computations lazy", () => {
    const scope = new ReactiveScope([["source", 1]]);
    let runs = 0;
    scope.defineComputed("doubled", () => {
      runs += 1;
      return Number(scope.get("source")) * 2;
    });

    scope.set("source", 2);
    scope.scheduler.flush();
    assert.equal(runs, 0);
    assert.equal(scope.get("doubled"), 4);
    assert.equal(runs, 1);
  });

  it("validates an observed chain without rerunning effects for an equal final result", () => {
    const scheduler = new ReactiveScope().scheduler;
    const source = createSignal(0);
    let bucketRuns = 0;
    let labelRuns = 0;
    let effectRuns = 0;
    const bucket = createComputed(scheduler, () => {
      bucketRuns += 1;
      return source.get() === 0 ? "empty" : "ready";
    });
    const label = createComputed(scheduler, () => {
      labelRuns += 1;
      return `Status: ${bucket.get()}`;
    });
    createEffect(scheduler, () => {
      effectRuns += 1;
      label.get();
    });

    source.set(1);
    scheduler.flush();
    assert.deepEqual([bucketRuns, labelRuns, effectRuns], [2, 2, 2]);

    source.set(2);
    scheduler.flush();
    assert.deepEqual([bucketRuns, labelRuns, effectRuns], [3, 3, 2]);
  });

  it("deduplicates a demanded computed diamond", () => {
    const scheduler = new ReactiveScope().scheduler;
    const source = createSignal(1);
    const left = createComputed(scheduler, () => source.get() + 1);
    const right = createComputed(scheduler, () => source.get() * 2);
    let joinedRuns = 0;
    const joined = createComputed(scheduler, () => {
      joinedRuns += 1;
      return left.get() + right.get();
    });
    let observed = 0;
    createEffect(scheduler, () => { observed = joined.get(); });

    source.set(2);
    scheduler.flush();
    assert.equal(observed, 7);
    assert.equal(joinedRuns, 2);
  });

  it("reports a lazy computed cycle when the value is demanded", () => {
    const scheduler = new ReactiveScope().scheduler;
    let left!: { get(): number };
    let right!: { get(): number };
    left = createComputed(scheduler, () => right.get() + 1);
    right = createComputed(scheduler, () => left.get() + 1);

    assert.throws(
      () => left.get(),
      (error: unknown) => error instanceof Error && error.message.includes("HR006"),
    );
  });

  it("allows an explicit read while paused without reattaching reactive work", () => {
    const scheduler = new ReactiveScope().scheduler;
    const source = createSignal(1);
    let runs = 0;
    const doubled = createComputed(scheduler, () => {
      runs += 1;
      return source.get() * 2;
    });

    doubled.pause();
    assert.equal(doubled.get(), 2);
    source.set(2);
    scheduler.flush();
    assert.equal(doubled.get(), 4);
    assert.equal(runs, 2);

    doubled.resume();
    assert.equal(doubled.get(), 4);
    assert.equal(runs, 3);
  });

  it("coalesces writes, propagates computed values first, and skips unrelated effects", async () => {
    const scope = new ReactiveScope([
      ["state", { count: 1, unrelated: 0 }],
      ["double", 0],
    ]);
    let computedRuns = 0;
    let domRuns = 0;
    let unrelatedRuns = 0;
    createEffect(scope.scheduler, () => {
      computedRuns += 1;
      scope.set("double", evaluate("state.count * 2", scope));
    }, 0);
    createEffect(scope.scheduler, () => {
      domRuns += 1;
      evaluate("double", scope);
    });
    createEffect(scope.scheduler, () => {
      unrelatedRuns += 1;
      evaluate("state.unrelated", scope);
    });

    const state = scope.get("state") as { count: number };
    state.count = 2;
    state.count = 3;
    await Promise.resolve();

    assert.equal(scope.get("double"), 6);
    assert.equal(computedRuns, 2);
    assert.equal(domRuns, 2);
    assert.equal(unrelatedRuns, 1);
  });

  it("retracks conditional dependencies and runs cleanup before rerun and stop", async () => {
    const scope = new ReactiveScope([["state", { useA: true, a: 1, b: 2 }]]);
    const values: number[] = [];
    let cleanups = 0;
    const effect = createEffect(scope.scheduler, () => {
      const state = scope.get("state") as { useA: boolean; a: number; b: number };
      values.push(state.useA ? state.a : state.b);
      return () => { cleanups += 1; };
    });
    const state = scope.get("state") as { useA: boolean; a: number; b: number };
    state.useA = false;
    await Promise.resolve();
    state.a = 9;
    await Promise.resolve();
    state.b = 7;
    await Promise.resolve();
    effect.stop();
    assert.deepEqual(values, [1, 2, 7]);
    assert.equal(cleanups, 3);
  });

  it("updates child-scope locals without losing parent dependencies", async () => {
    const parent = new ReactiveScope([["suffix", "!"]]);
    const child = parent.fork([["row", { label: "A" }]]);
    const seen: unknown[] = [];
    createEffect(parent.scheduler, () => {
      seen.push([evaluate("row.label", child), evaluate("suffix", child)]);
    });
    child.set("row", { label: "B" });
    parent.set("suffix", "?");
    await Promise.resolve();
    assert.deepEqual(seen, [["A", "!"], ["B", "?"]]);
  });

  it("bounds a reactive write cycle and clears the runaway queue", () => {
    const scope = new ReactiveScope([["count", 0]]);
    let runs = 0;
    createEffect(scope.scheduler, () => {
      runs += 1;
      scope.set("count", (scope.get("count") as number) + 1);
    });

    assert.throws(
      () => scope.scheduler.flush(),
      (error: unknown) => error instanceof Error && error.message.includes("HR006"),
    );
    assert.equal(runs, 101);

    scope.scheduler.flush();
    assert.equal(runs, 101);
  });

  it("bounds a write cycle that passes through a computed value", () => {
    const scheduler = new ReactiveScope().scheduler;
    const source = createSignal(0);
    const next = createComputed(scheduler, () => source.get() + 1);
    let runs = 0;
    createEffect(scheduler, () => {
      runs += 1;
      source.set(next.get());
    });

    assert.throws(
      () => scheduler.flush(),
      (error: unknown) => error instanceof Error && error.message.includes("HR006"),
    );
    assert.equal(runs, 101);
  });

  it("allows wide fan-out because the loop bound is per effect", () => {
    const scope = new ReactiveScope([["value", 0]]);
    let runs = 0;
    for (let index = 0; index < 200; index += 1) {
      createEffect(scope.scheduler, () => {
        scope.get("value");
        runs += 1;
      });
    }

    scope.set("value", 1);
    scope.scheduler.flush();
    assert.equal(runs, 400);
  });

  it("falls back without duplicating effects when one dependency spans schedulers", async () => {
    const shared = { value: 0 };
    const first = new ReactiveScope([["shared", shared]]);
    const second = new ReactiveScope([["shared", shared]]);
    let firstRuns = 0;
    let secondRuns = 0;
    createEffect(first.scheduler, () => {
      void (first.get("shared") as typeof shared).value;
      firstRuns += 1;
    });
    createEffect(second.scheduler, () => {
      void (second.get("shared") as typeof shared).value;
      secondRuns += 1;
    });

    (first.get("shared") as typeof shared).value = 1;
    await Promise.resolve();

    assert.equal(firstRuns, 2);
    assert.equal(secondRuns, 2);
  });
});
