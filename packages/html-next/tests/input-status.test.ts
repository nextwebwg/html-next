import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { createEffect, ReactiveScope } from "../src/reactivity.js";
import { publicInputStatus, readInputStatus } from "../src/input-status.js";
import { evaluate } from "../src/expression.js";
import { READY_INPUT } from "../src/inputs.js";

describe("binding availability", () => {
  it("derives availability from actual reads, including short circuits and lexical context", () => {
    const scope = new ReactiveScope([["enabled", false], ["product", null]]);
    scope.setInputStatus("product", { ready: false, pending: true, error: null, stale: false });
    scope.defineComputed("label", () => scope.get("enabled") ? evaluate("concat($product.name, '!')", scope) : "Disabled");
    const context = new ReactiveScope([], scope.scheduler);
    context.defineComputed("inherited", () => scope.get("label")!);
    assert.equal(context.get("inherited"), "Disabled");
    assert.deepEqual(context.inputStatus("inherited"), READY_INPUT);
    scope.set("enabled", true);
    scope.scheduler.flush();
    assert.equal(context.get("inherited"), null);
    assert.deepEqual(context.inputStatus("inherited"), { ready: false, pending: true, error: null, stale: false });
    scope.setInputStatus("product", { ready: false, pending: false, error: { name: "Offline", message: "Offline." }, stale: false });
    scope.scheduler.flush();
    assert.equal(context.inputStatus("inherited").error?.message, "Offline.");
    scope.set("product", { name: "Coffee" });
    scope.setInputStatus("product", READY_INPUT);
    scope.scheduler.flush();
    assert.equal(context.get("inherited"), "Coffee!");
    assert.equal(context.inputStatus("inherited").ready, true);
    scope.setInputStatus("product", { ...READY_INPUT, pending: true, stale: true });
    scope.scheduler.flush();
    assert.equal(context.get("inherited"), "Coffee!");
    assert.deepEqual(context.inputStatus("inherited"), { ...READY_INPUT, pending: true, stale: true });
    scope.set("enabled", false);
    scope.scheduler.flush();
    assert.deepEqual(context.inputStatus("inherited"), READY_INPUT);
    scope.setInputStatus("product", { ready: false, pending: false, error: { name: "Offline", message: "Ignored branch." }, stale: false });
    scope.scheduler.flush();
    assert.equal(context.get("inherited"), "Disabled");
    assert.deepEqual(context.inputStatus("inherited"), READY_INPUT);
  });

  it("notifies await consumers when only a computed prerequisite's status changes", () => {
    const scope = new ReactiveScope([["product", { name: "Coffee" }]]);
    scope.setInputStatus("product", READY_INPUT);
    let computations = 0;
    scope.defineComputed("name", () => { computations += 1; return evaluate("$product.name", scope); });
    const statuses: boolean[] = [];
    createEffect(scope.scheduler, () => { statuses.push(scope.inputStatus("name").pending); });
    scope.setInputStatus("product", { ...READY_INPUT, pending: true });
    scope.scheduler.flush();
    assert.deepEqual(statuses, [false, true]);
    assert.equal(scope.get("name"), "Coffee");
    assert.equal(computations, 2);
  });

  it("copies public failure fields without retaining private producer data or freezing", () => {
    const error = { name: "NetworkError", message: "Offline", stack: "private", retry: () => {} };
    const status = publicInputStatus({ ready: false, pending: false, error, stale: false });
    error.message = "Changed later";
    assert.deepEqual(status.error, { name: "NetworkError", message: "Offline" });
    assert.equal(Object.isFrozen(status), false);
    assert.equal(Object.isFrozen(status.error), false);
    assert.throws(() => publicInputStatus({ ready: false, pending: false, error: null, stale: true }), TypeError);
  });

  it("distinguishes availability from truthiness and current activity", () => {
    const scope = new ReactiveScope();
    for (const value of [false, 0, "", [], null]) {
      scope.set("product", value);
      assert.deepEqual(readInputStatus(scope, "product", false), { ready: true, pending: false, error: null, stale: false });
    }
    scope.setInputStatus("product", { ready: false, pending: false, error: null, stale: false });
    assert.equal(readInputStatus(scope, "product", false).ready, false);
    assert.equal(scope.get("product"), null, "availability is separate from the accepted value");
  });

  it("updates status readers when the accepted value has not changed", async () => {
    const scope = new ReactiveScope([["product", { name: "Coffee" }]]);
    const observed: boolean[] = [];
    const effect = createEffect(scope.scheduler, () => { observed.push(readInputStatus(scope, "product", false).pending); });
    const value = scope.get("product");
    scope.setInputStatus("product", { ready: true, pending: true, error: null, stale: false });
    await Promise.resolve();
    assert.equal(scope.get("product"), value);
    assert.deepEqual(observed, [false, true]);
    scope.setInputStatus("product", { ready: true, pending: false, error: { name: "Error", message: "Offline" }, stale: false });
    await Promise.resolve();
    assert.deepEqual(observed, [false, true, false]);
    effect.stop();
  });

  it("follows the lexical owner and propagates an unhandled initial failure", () => {
    const scope = new ReactiveScope([["product", null]]);
    const status = { ready: false, pending: false, error: { name: "NetworkError", message: "Offline" }, stale: false };
    scope.setInputStatus("product", status);
    const child = new ReactiveScope([], scope.scheduler, scope);
    assert.deepEqual(readInputStatus(child, "product", true), status);
    assert.throws(() => readInputStatus(child, "product", false), { name: "NetworkError", message: "Offline" });
    child.set("product", 0);
    assert.equal(readInputStatus(child, "product", false).ready, true);
  });
});
