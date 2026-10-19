import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { createEffect, ReactiveScope } from "../src/reactivity.js";
import { publicInputStatus, readInputStatus } from "../src/input-status.js";
import { compileExpression, evaluate, evaluateCompiled } from "../src/expression.js";
import { inputComputed, inputDefault, READY_INPUT } from "../src/inputs.js";

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

  it("makes a default fallback available without hiding the selected value's status", () => {
    const scope = new ReactiveScope([["label", null], ["fallback", "Default"]]);
    scope.setInputStatus("label", { ready: false, pending: false, error: null, stale: false });
    scope.defineComputed("text", () => evaluate("default($label, $fallback)", scope));
    assert.equal(scope.get("text"), "Default");
    assert.deepEqual(scope.inputStatus("text"), READY_INPUT);
    scope.set("label", "Selected");
    scope.setInputStatus("label", { ...READY_INPUT, pending: true });
    scope.setInputStatus("fallback", { ready: false, pending: false, error: null, stale: false });
    scope.scheduler.flush();
    assert.equal(scope.get("text"), "Selected");
    assert.deepEqual(scope.inputStatus("text"), { ...READY_INPUT, pending: true });
    scope.set("label", null);
    scope.scheduler.flush();
    assert.equal(scope.get("text"), null);
    assert.equal(scope.inputStatus("text").ready, false);
  });

  it("retains an accepted default expression when its selected branch becomes nonconforming", () => {
    const scope = new ReactiveScope([["enabled", true]]);
    const expression = compileExpression("default($enabled ? 2px : 1px + 1rem, 3px)");
    scope.defineComputed("size", () => evaluateCompiled(expression, scope));
    assert.equal(scope.get("size"), "2px");
    scope.set("enabled", false);
    scope.scheduler.flush();
    assert.equal(scope.get("size"), "2px");
    assert.deepEqual(scope.inputStatus("size"), READY_INPUT);
  });

  it("retains a framework default computation when its primary result is nonconforming", () => {
    const invalid = Symbol.for("html-next.invalid-result");
    let candidate: unknown = "Accepted";
    let accepted: unknown = null;
    const value = inputComputed(() => inputDefault(() => candidate, () => "Fallback"),
      read => ({ get: read }), next => next === invalid ? accepted : (accepted = next));
    assert.equal(value.get(), "Accepted");
    candidate = invalid;
    assert.equal(value.get(), "Accepted");
    assert.deepEqual(value.status(), READY_INPUT);
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
