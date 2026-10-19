import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { PropInputs } from "../src/prop-inputs.js";
import { READY_INPUT, type InputStatus } from "../src/inputs.js";
import { parseTypeExpression, parseTypedValue } from "../src/type-system.js";

const pending: InputStatus = { ready: false, pending: true, stale: false, error: null };
const failed: InputStatus = { ...pending, pending: false, error: { name: "Offline", message: "Unavailable" } };
function create(defaults: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = { product: null };
  const type = parseTypeExpression("object({ name: string })");
  let invalidations = 0;
  const inputs = new PropInputs({ names: ["product"], values, defaults,
    check: (_name, value) => value === null ? { ok: true, value } : parseTypedValue(value, type),
    invalidate: () => { invalidations += 1; } });
  const port = inputs.port({ track() {}, watch(run) { run(); return () => {}; }, untracked: run => run() });
  return { inputs, values, port, invalidations: () => invalidations };
}

describe("framework prop input bookkeeping", () => {
  it("preserves a source publication made after rendering but before commit", () => {
    const { inputs, values, port } = create();
    const source = port.source("product");
    source.publish({ value: { name: "Before render" }, status: READY_INPUT });
    const type = parseTypeExpression("object({ name: string })");
    const options = { names: ["product"], values, defaults: {}, check: (_name: string, value: unknown) => parseTypedValue(value, type), invalidate() {} };
    const candidate = inputs.fork(options);
    candidate.value("product", undefined);
    source.publish({ value: { name: "During layout" }, status: READY_INPUT });
    inputs.commit(candidate);
    assert.deepEqual(port.read("product"), { name: "During layout" });
    assert.equal(port.supplied("product"), false);
    const revision = port.revision("product")!;
    inputs.value("product", { name: 7 });
    assert.equal(port.revision("product"), revision, "refused caller input does not invalidate accepted data");
  });

  it("checks source results against the current accepted selector between render commits", () => {
    const check = (name: string, value: unknown, _source: boolean, accepted: Readonly<Record<string, unknown>>) =>
      parseTypedValue(value, parseTypeExpression(name === "mode" ? "string" : accepted.mode === "text" ? "string" : "number"));
    const values = { mode: "number", value: null as unknown };
    const options = { names: ["mode", "value"], values, defaults: { mode: "number" }, check, invalidate() {} };
    const inputs = new PropInputs(options);
    const port = inputs.port({ track() {}, watch: () => () => {}, untracked: run => run() });
    const mode = port.source("mode");
    const value = port.source("value");
    mode.publish({ value: "number", status: READY_INPUT });
    value.publish({ value: 2, status: READY_INPUT });
    const candidate = inputs.fork(options);
    inputs.commit(candidate);
    mode.publish({ value: "text", status: READY_INPUT });
    assert.equal(value.publish({ value: "hello", status: READY_INPUT }), true);
    assert.equal(port.read("value"), "hello");
    assert.equal(candidate.read("mode"), "number", "the previous render view remains a snapshot");
    assert.equal(value.publish({ value: 42, status: READY_INPUT }), false);
    assert.equal(port.read("value"), "hello");
  });

  it("resolves null caller, parent and producer inputs to the default without releasing ownership", () => {
    const fallback = { name: "Default" };
    const { inputs, port } = create({ product: fallback });
    const source = port.source("product");
    inputs.value("product", { name: "Fixture" });
    inputs.value("product", null);
    assert.deepEqual(port.read("product"), fallback);
    assert.equal(port.supplied("product"), true);
    assert.equal(source.publish({ value: { name: "Remote" }, status: READY_INPUT }), false);
    assert.equal(inputs.inputValue("product"), null);
    inputs.value("product", undefined);
    assert.equal(source.publish({ value: null, status: READY_INPUT }), true);
    assert.deepEqual(port.read("product"), fallback);
    assert.equal(port.supplied("product"), false);
    inputs.value("product", null, { product: () => ({ value: null, status: READY_INPUT }) });
    assert.deepEqual(port.read("product"), fallback);
    assert.equal(port.supplied("product"), true);
    assert.equal(port.status("product").ready, true);
  });

  it("keeps producer values and status through rerenders without transferring ownership", () => {
    const { inputs, values, port } = create();
    inputs.value("product", undefined);
    const source = port.source("product");
    assert.equal(source.publish({ status: pending }), true);
    inputs.value("product", undefined);
    assert.deepEqual(port.status("product"), pending);
    source.publish({ value: { name: "Coffee" }, status: READY_INPUT });
    inputs.value("product", undefined);
    assert.deepEqual(values.product, { name: "Coffee" });
    assert.equal(port.supplied("product"), false);
    source.publish({ value: values.product, status: { ...READY_INPUT, pending: true } });
    inputs.value("product", undefined);
    assert.equal(port.status("product").pending, true);
    source.publish({ value: values.product, status: { ...READY_INPUT, error: failed.error } });
    assert.equal(port.status("product").ready, true);
    assert.equal(source.publish({ value: { name: 7 }, status: READY_INPUT }), false);
  });

  it("allows fixture replacement, nullable fixtures and explicit release", () => {
    const { inputs, port } = create();
    const source = port.source("product");
    inputs.value("product", { name: "Fixture" });
    assert.equal(source.publish({ status: pending }), false);
    inputs.value("product", null);
    assert.equal(port.status("product").ready, true);
    assert.equal(port.supplied("product"), true);
    inputs.value("product", undefined);
    assert.equal(port.supplied("product"), false);
    assert.equal(port.status("product").ready, false);
    assert.equal(source.publish({ value: { name: "Remote" }, status: READY_INPUT }), true);
  });

  it("retains refused caller attempts for validation while accepting producer results", () => {
    const { inputs, port } = create();
    const source = port.source("product");
    source.publish({ value: { name: "Coffee" }, status: READY_INPUT });
    const flags: Record<string, boolean> = {};
    inputs.value("product", { name: 7 }, undefined, flags);
    assert.equal(flags.product, false);
    assert.equal(port.supplied("product"), false);
    source.publish({ value: { name: "Fresh" }, status: READY_INPUT });
    assert.deepEqual(inputs.inputValue("product"), { name: 7 });
    inputs.value("product", undefined);
    assert.equal(inputs.inputValue("product"), null);
    assert.equal(port.status("product").ready, false);
  });

  it("carries unavailable ownership, errors and status-only updates from a parent", () => {
    const { inputs, port } = create();
    let snapshot = { status: pending, value: null as unknown };
    const bindings = { product: () => snapshot };
    inputs.value("product", null, bindings);
    assert.equal(port.supplied("product"), true);
    assert.equal(port.source("product").publish({ value: { name: "Default" }, status: READY_INPUT }), false);
    snapshot = { status: failed, value: null };
    inputs.value("product", null, bindings);
    assert.deepEqual(port.status("product"), failed);
    snapshot = { status: READY_INPUT, value: { name: "Coffee" } };
    inputs.value("product", snapshot.value, bindings);
    const status = inputs.status("product");
    inputs.value("product", snapshot.value, bindings);
    assert.equal(inputs.status("product"), status, "unchanged status does not invalidate effects");
    assert.deepEqual(port.read("product"), { name: "Coffee" });
    bindings.product = () => ({ status: { ...READY_INPUT, pending: true }, value: snapshot.value });
    inputs.value("product", snapshot.value, bindings);
    assert.equal(port.status("product").pending, true);
  });

  it("copies observable status without freezing it and keeps explicit defaults available", () => {
    const { inputs, port } = create({ product: { name: "Default" } });
    inputs.value("product", undefined);
    const source = port.source("product");
    source.publish({ status: pending });
    assert.equal(port.status("product").ready, true);
    source.publish({ status: failed });
    const status = port.status("product");
    Reflect.set(status.error!, "message", "Changed");
    Reflect.set(status, "ready", false);
    assert.equal(port.status("product").error?.message, "Unavailable");
    assert.equal(Object.isFrozen(status), false);
  });

  it("keeps abandoned render candidates separate from the instance's source capabilities", () => {
    const { inputs, values, port } = create();
    const source = port.source("product");
    source.publish({ value: { name: "Committed" }, status: READY_INPUT });
    const candidate = inputs.fork({ names: ["product"], values, defaults: {},
      check: (_name, value) => ({ ok: true, value }), invalidate() {} });
    candidate.value("product", { name: "Tentative fixture" });
    assert.equal(candidate.committed, inputs);
    assert.equal(candidate.supplied("product"), true);
    assert.equal(port.supplied("product"), false);
    assert.deepEqual(values.product, { name: "Committed" });
    assert.equal(source.publish({ value: { name: "During render" }, status: READY_INPUT }), true);
    assert.deepEqual(port.read("product"), { name: "During render" });
    assert.deepEqual(candidate.committed.read("product"), { name: "During render" });
    // The renderer validates its external-store revision before committing a candidate.
    // Only an actual commit transfers caller ownership to the connected instance.
    inputs.commit(candidate);
    assert.deepEqual(port.read("product"), { name: "Tentative fixture" });
    assert.equal(source.publish({ status: pending }), false);
  });

  it("distinguishes an omitted required input from a refused null", () => {
    const type = parseTypeExpression("number");
    const values = { amount: null as unknown };
    const inputs = new PropInputs({ names: ["amount"], values, defaults: {},
      check: (_name, value) => parseTypedValue(value, type), invalidate() {} });
    inputs.value("amount", undefined);
    assert.equal(inputs.status("amount").ready, false);
    inputs.value("amount", null);
    assert.equal(inputs.supplied("amount"), false);
    inputs.value("amount", 3);
    inputs.value("amount", null);
    assert.equal(inputs.read("amount"), 3);
    assert.equal(inputs.supplied("amount"), true, "a refused attempt preserves the previous caller input");
    inputs.value("amount", undefined);
    assert.equal(inputs.supplied("amount"), false, "omission releases even a required input");
  });
});
