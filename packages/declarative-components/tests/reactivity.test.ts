import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { evaluate } from "../src/expression.js";
import { createEffect, ReactiveScope } from "../src/reactivity.js";

describe("reactive scope", () => {
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
});
