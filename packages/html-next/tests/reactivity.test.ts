import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { evaluate, NONCONFORMING, type Value } from "../src/expression.js";
import {
  createComputed,
  createEffect,
  createSignal,
  type ReactiveEffect,
  ReactiveScope,
} from "../src/reactivity.js";

describe("reactive scope", () => {
  it("keeps one subscription per dependency when reordered reads repeat", () => {
    for (const width of [3, 96]) {
      const scheduler = new ReactiveScope().scheduler;
      const reversed = createSignal(false);
      const values = Array.from({ length: width }, (_, index) => createSignal(index));
      let runs = 0;
      const effect = createEffect(scheduler, () => {
        runs += 1;
        const order = reversed.get() ? [values[width - 1]!, ...values.slice(0, -1)] : values;
        for (const value of order) value.get();
        values[width - 1]!.get();
      });
      const subscriptions = (owner: ReactiveEffect): number => {
        let count = 0;
        for (let link = owner.dependencies; link !== undefined; link = link.nextDependency) count += 1;
        return count;
      };
      assert.equal(subscriptions(effect), width + 1);
      reversed.set(true);
      scheduler.flush();
      assert.equal(subscriptions(effect), width + 1);
      values[0]!.set(-1);
      scheduler.flush();
      assert.equal(runs, 3);
      assert.equal(subscriptions(effect), width + 1);
      effect.stop();
      assert.equal(subscriptions(effect), 0);
    }
  });

  it("releases wide conditional dependencies and reconnects nested computed readers", () => {
    const scheduler = new ReactiveScope().scheduler;
    const wide = createSignal(true);
    const values = Array.from({ length: 96 }, (_, index) => createSignal(index));
    const derived = createComputed(scheduler, () => values[0]!.get() * 2);
    const seen: number[] = [];
    let cleanups = 0;
    const effect = createEffect(scheduler, () => {
      let total = 0;
      for (const value of wide.get() ? values : values.slice(0, 1)) total += value.get();
      // A nested owner shares the first dependency; the outer duplicate remains deduplicated.
      seen.push(total + derived.get() + values[0]!.get());
      return () => { cleanups += 1; };
    });
    assert.deepEqual(seen, [4560]);
    wide.set(false);
    scheduler.flush();
    values[95]!.set(500);
    scheduler.flush();
    assert.deepEqual(seen, [4560, 0]);
    values[0]!.set(2);
    scheduler.flush();
    assert.deepEqual(seen, [4560, 0, 8]);
    effect.pause();
    wide.set(true);
    values[0]!.set(3);
    scheduler.flush();
    assert.equal(seen.length, 3);
    effect.resume();
    assert.equal(seen.at(-1), 4977);
    effect.stop();
    derived.stop();
    values[0]!.set(4);
    scheduler.flush();
    assert.equal(seen.length, 4);
    assert.equal(cleanups, 4);
  });

  it("reads frozen nested values without violating native proxy invariants", () => {
    const source = Object.freeze({ nested: Object.freeze({ value: 7 }) });
    const scope = new ReactiveScope([["source", source]]);
    assert.equal(evaluate("source.nested.value", scope), 7);
  });
  it("stores native events without proxying them, including inside reactive structures", () => {
    const event = new CustomEvent("select", { detail: { item: "Ada" }, cancelable: true });
    const scope = new ReactiveScope([["event", event], ["selection", { source: event, item: "Ada" }]]);
    assert.equal(scope.get("event"), event);
    assert.equal((scope.get("selection") as { source: Value }).source, event);
    assert.equal(evaluate("$event.detail.item", scope), "Ada");
    assert.equal(evaluate("$selection.source.type", scope), "select");
    const seen: Value[] = [];
    createEffect(scope.scheduler, () => { seen.push(scope.get("event")!); });
    event.preventDefault();
    scope.scheduler.flush();
    assert.equal(evaluate("$event.defaultPrevented", scope), true);
    assert.deepEqual(seen, [event]);
    scope.set("event", event);
    scope.scheduler.flush();
    assert.deepEqual(seen, [event]);
    const next = new Event("next");
    scope.set("event", next);
    scope.scheduler.flush();
    assert.deepEqual(seen, [event, next]);
  });

  it("keeps a computed null until its first valid result, then retains its last valid result", () => {
    const scope = new ReactiveScope([["source", "oops"]]);
    const seen: unknown[] = [];
    scope.defineComputed("derived", () => {
      const source = scope.get("source");
      return typeof source === "number" ? source * 2 : NONCONFORMING as unknown as Value;
    });
    createEffect(scope.scheduler, () => { seen.push(scope.get("derived")); });
    assert.deepEqual(seen, [null]);

    scope.set("source", 2);
    scope.scheduler.flush();
    assert.deepEqual(seen, [null, 4]);

    scope.set("source", "oops");
    scope.scheduler.flush();
    assert.equal(scope.get("derived"), 4);
    assert.deepEqual(seen, [null, 4]);

    scope.set("source", 7);
    scope.scheduler.flush();
    assert.deepEqual(seen, [null, 4, 14]);
  });

  it("updates serialized arrays when index writes extend their length", () => {
    const scope = new ReactiveScope([["items", ["a"]]]);
    const items = scope.get("items") as string[];
    const seen: string[] = [];
    createEffect(scope.scheduler, () => { seen.push(String(scope.get("items"))); });
    assert.deepEqual(seen, ["a"]);

    items.push("b");
    scope.scheduler.flush();
    assert.deepEqual(seen, ["a", "a,b"]);

    items[3] = "d";
    scope.scheduler.flush();
    assert.deepEqual(seen, ["a", "a,b", "a,b,,d"]);
    items[3] = "d";
    scope.scheduler.flush();
    assert.equal(seen.length, 3);
  });

  it("notifies deleted array indices when length shrinks without notifying retained indices", () => {
    const scope = new ReactiveScope([["items", ["a", "b", "c"]]]);
    const items = scope.get("items") as string[];
    const deleted: unknown[] = [];
    const retained: unknown[] = [];
    const lengths: unknown[] = [];
    createEffect(scope.scheduler, () => { deleted.push((scope.get("items") as string[])[2]); });
    createEffect(scope.scheduler, () => { retained.push((scope.get("items") as string[])[0]); });
    createEffect(scope.scheduler, () => { lengths.push((scope.get("items") as string[]).length); });

    items.length = 1;
    scope.scheduler.flush();
    assert.deepEqual(deleted, ["c", undefined]);
    assert.deepEqual(retained, ["a"]);
    assert.deepEqual(lengths, [3, 1]);

    items.length = 1;
    scope.scheduler.flush();
    assert.equal(deleted.length, 2);
    assert.equal(lengths.length, 2);

    items[2] = "next";
    scope.scheduler.flush();
    assert.deepEqual(deleted, ["c", undefined, "next"]);
    assert.deepEqual(lengths, [3, 1, 3]);
  });

  it("does not notify consumers for Object.is-equal signal writes", () => {
    const scheduler = new ReactiveScope().scheduler;
    const object = {};
    const source = createSignal<unknown>(object);
    let runs = 0;
    createEffect(scheduler, () => {
      runs += 1;
      source.get();
    });

    source.set(object);
    source.update((value) => value);
    scheduler.flush();
    assert.equal(runs, 1);

    source.set(Number.NaN);
    scheduler.flush();
    source.set(Number.NaN);
    scheduler.flush();
    assert.equal(runs, 2);

    source.set(0);
    scheduler.flush();
    source.set(-0);
    scheduler.flush();
    assert.equal(runs, 4);
  });

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

  it("does not evaluate named computations for key metadata", () => {
    const scope = new ReactiveScope([["source", 1]]);
    let runs = 0;
    scope.defineComputed("doubled", () => {
      runs += 1;
      return Number(scope.get("source")) * 2;
    });

    assert.equal(scope.has("doubled"), true);
    assert.equal(runs, 0);
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

  it("coalesces observed computed refreshes and compares only the batch-final value", () => {
    const scheduler = new ReactiveScope().scheduler;
    const source = createSignal(0);
    let computedRuns = 0;
    let effectRuns = 0;
    let observed = -1;
    const value = createComputed(scheduler, () => {
      computedRuns += 1;
      return source.get();
    });
    createEffect(scheduler, () => {
      effectRuns += 1;
      observed = value.get();
    });

    source.set(1);
    source.set(0);
    assert.deepEqual([computedRuns, effectRuns], [1, 1]);
    scheduler.flush();
    assert.deepEqual([computedRuns, effectRuns, observed], [2, 1, 0]);

    source.set(1);
    source.set(2);
    assert.deepEqual([computedRuns, effectRuns], [2, 1]);
    scheduler.flush();
    assert.deepEqual([computedRuns, effectRuns, observed], [3, 2, 2]);
  });

  it("runs a consumer once when it reads both a source and its computed value", () => {
    const scheduler = new ReactiveScope().scheduler;
    const source = createSignal(0);
    const doubled = createComputed(scheduler, () => source.get() * 2);
    let runs = 0;
    createEffect(scheduler, () => {
      runs += 1;
      source.get();
      doubled.get();
    });

    source.set(1);
    scheduler.flush();
    assert.equal(runs, 2);
  });

  it("runs a consumer once when it reads both ancestor and descendant computeds", () => {
    const scheduler = new ReactiveScope().scheduler;
    const source = createSignal(1);
    const ancestor = createComputed(scheduler, () => source.get() + 1);
    const descendant = createComputed(scheduler, () => ancestor.get() * 2);
    let runs = 0;
    createEffect(scheduler, () => {
      runs += 1;
      ancestor.get();
      descendant.get();
    });

    source.set(2);
    scheduler.flush();
    assert.equal(runs, 2);
  });

  it("settles descendant computeds before a consumer shared with their source", () => {
    const scheduler = new ReactiveScope().scheduler;
    const source = createSignal(1);
    const ancestor = createComputed(scheduler, () => source.get() + 1);
    const descendant = createComputed(scheduler, () => ancestor.get() * 2);
    let runs = 0;
    createEffect(scheduler, () => {
      runs += 1;
      source.get();
      ancestor.get();
      descendant.get();
    });

    source.set(2);
    scheduler.flush();
    assert.equal(runs, 2);
  });

  it("settles computed work released by an earlier ordinary effect", () => {
    const scheduler = new ReactiveScope().scheduler;
    const source = createSignal(1);
    const kick = createSignal(0);
    const derived = createComputed(scheduler, () => source.get() * 2);
    let writerRuns = 0;
    let consumerRuns = 0;
    let consumerCleanups = 0;
    createEffect(scheduler, () => {
      writerRuns += 1;
      const value = kick.get();
      if (value > 0) source.set(value + 1);
    });
    createEffect(scheduler, () => {
      consumerRuns += 1;
      kick.get();
      derived.get();
      return () => { consumerCleanups += 1; };
    });

    kick.set(1);
    scheduler.flush();
    assert.deepEqual({ writerRuns, consumerRuns, consumerCleanups }, {
      writerRuns: 2,
      consumerRuns: 2,
      consumerCleanups: 1,
    });
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
    // Each invalid cycle step occupies one computed-refresh round and one consumer-effect round.
    assert.equal(runs, 51);
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
