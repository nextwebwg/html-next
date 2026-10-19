import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { afterEach, describe, it, vi } from "vitest";
import { componentInputs, READY_INPUT, type InputSnapshot, type InputStatus } from "../src/inputs.js";
import { parseComponent } from "../src/source-parser.js";
import { componentRegistry, getComponentHost, lowerDocument, registerComponentDefinitions, serializeRenderedForm } from "../src/runtime.js";

const pending: InputStatus = { ready: false, pending: true, error: null, stale: false };
const failed: InputStatus = { ready: false, pending: false, error: { name: "NetworkError", message: "Offline" }, stale: false };
const source = '<template component="x-input"><defs><prop name="product" type="object({ name: string })">Product.</prop></defs><section><template $await="binding of $product"><h2>{$product.name}</h2><input value="initial"><small $if="$binding.pending">Refreshing.</small></template><p $error="problem">{$problem.message}</p><i $else>Loading.</i></section></template>';
const windows: JSDOM[] = [];

function create(definitionSource = source, definitions: string[] = [], html = "<x-input></x-input>") {
  const dom = new JSDOM(`<!doctype html><html><head></head><body>${html}</body></html>`, { url: "https://example.test/" });
  windows.push(dom);
  for (const name of ["Node", "Element", "HTMLElement", "Text", "Comment", "HTMLTemplateElement", "HTMLInputElement", "HTMLTextAreaElement", "HTMLSelectElement", "HTMLOptionElement", "HTMLFormElement", "MutationObserver", "Event", "CustomEvent", "KeyboardEvent", "MouseEvent"]) {
    vi.stubGlobal(name, Reflect.get(dom.window, name));
  }
  const document = dom.window.document;
  const existingInput = document.querySelector("input");
  registerComponentDefinitions([definitionSource, ...definitions].map(source => parseComponent(source)), document);
  lowerDocument(document, { connect: false });
  const root = document.querySelector("section")!;
  const host = getComponentHost(root)!;
  return { document, root, host, existingInput, inputs: componentInputs(host) };
}
const settle = async () => { for (let i = 0; i < 4; i += 1) await Promise.resolve(); };
afterEach(() => { for (const window of windows.splice(0)) window.window.close(); vi.unstubAllGlobals(); });

describe("renderer input source port", () => {
  it("captures actual reads and their failures without leaking nested observation scopes", () => {
    const { inputs } = create();
    const product = inputs.source("product");
    product.publish({ status: pending });
    const unavailable = inputs.capture(() => (inputs.read("product") as { name: string }).name);
    assert.equal(unavailable.ok, false);
    assert.deepEqual(unavailable.status, pending);
    const ignored = inputs.capture(() => {
      const nested = inputs.capture(() => inputs.read("product"));
      assert.deepEqual(nested.status, pending);
      return "Independent";
    });
    assert.deepEqual(ignored, { ok: true, value: "Independent", status: READY_INPUT });
    const error = new Error("Selector bug");
    assert.deepEqual(inputs.capture(() => { throw error; }), { ok: false, error, status: READY_INPUT });
    product.publish({ value: { name: "Coffee" }, status: READY_INPUT });
    assert.deepEqual(inputs.capture(() => inputs.read("product")), { ok: true, value: { name: "Coffee" }, status: READY_INPUT });
  });

  it("does not notify status readers for an equivalent publication", async () => {
    const { inputs, host } = create();
    const product = inputs.source("product");
    let runs = 0;
    const stop = inputs.watch(() => { inputs.status("product"); runs += 1; });
    let rawRuns = 0;
    const stopRaw = inputs.watch(() => { void host.props.product!.inputValue; rawRuns += 1; });
    product.publish({ status: pending });
    await settle();
    const afterPending = runs;
    const rawAfterPending = rawRuns;
    product.publish({ status: { ...pending } });
    await settle();
    assert.equal(runs, afterPending);
    assert.equal(rawRuns, rawAfterPending);
    product.publish({ status: failed });
    await settle();
    const afterError = runs;
    assert.equal(afterError, afterPending + 1);
    product.publish({ status: { ...failed, error: { ...failed.error! } } });
    await settle();
    assert.equal(runs, afterError);
    assert.equal(rawRuns, rawAfterPending, "status-only failure does not rewrite raw input");
    stop(); stopRaw();
  });

  it("resets a child's bound input to its default when a parent expression becomes null", async () => {
    const parent = '<template component="x-input"><defs><prop name="enabled" type="boolean" default="true">Enabled.</prop></defs><section><x-child from:product="$enabled ? { name: \'Fixture\' } : null"></x-child></section></template>';
    const child = source.replace('component="x-input"', 'component="x-child"').replace('type="object({ name: string })"', 'type="object({ name: string })" default="{ name: \'Default\' }"');
    const { root, inputs } = create(parent, [child]);
    assert.equal(root.querySelector("h2")?.textContent, "Fixture");
    inputs.source("enabled").publish({ value: false, status: READY_INPUT });
    await settle();
    assert.equal(root.querySelector("h2")?.textContent, "Default");
  });

  it("uses a declared default for null inputs through updates, source writes and adoption", async () => {
    const definition = source.replace('type="object({ name: string })"', 'type="object({ name: string })" default="{ name: \'Default\' }"');
    const server = create(definition);
    const product = server.inputs.source("product");
    product.publish({ value: { name: "Remote" }, status: READY_INPUT });
    product.publish({ value: null, status: READY_INPUT });
    await settle();
    assert.equal(server.root.querySelector("h2")?.textContent, "Default");
    componentRegistry.update(server.root, { product: { name: "Fixture" } });
    componentRegistry.update(server.root, { product: null });
    await settle();
    assert.equal(server.root.querySelector("h2")?.textContent, "Default");
    assert.equal(server.inputs.supplied("product"), true);
    assert.equal(server.host.props.product!.validity.valid, true);
    const client = create(definition, [], serializeRenderedForm(server.document.body));
    assert.deepEqual(client.inputs.read("product"), { name: "Default" });
    assert.equal(client.inputs.supplied("product"), true);
    assert.equal(client.inputs.source("product").publish({ value: { name: "Remote" }, status: READY_INPUT }), false);
  });

  it("renders a computed's prerequisite failure and refresh status without changing its value type", async () => {
    const { root, inputs } = create('<template component="x-input"><defs><prop name="product" type="object({ name: string })">Product.</prop><prop name="enabled" type="boolean" default="false">Enabled.</prop><computed name="label" type="string" from="$enabled ? concat($product.name, \'!\') : \'Disabled\'"></computed></defs><section><template $await="binding of $label"><h2>{$label}</h2><input value="initial"><small $if="$binding.pending">Refreshing.</small></template><p $error="problem">{$problem.message}</p><i $else>Loading.</i></section></template>');
    assert.equal(root.querySelector("h2")?.textContent, "Disabled");
    const source = inputs.source("product");
    const enabled = inputs.source<boolean>("enabled");
    enabled.publish({ value: true, status: READY_INPUT });
    source.publish({ status: pending });
    await settle();
    assert.equal(root.querySelector("i")?.textContent, "Loading.");
    source.publish({ status: failed });
    await settle();
    assert.equal(root.querySelector("p")?.textContent, "Offline");
    source.publish({ value: { name: "Coffee" }, status: READY_INPUT });
    await settle();
    assert.equal(root.querySelector("h2")?.textContent, "Coffee!");
    const input = root.querySelector("input")!;
    source.publish({ value: { name: "Coffee" }, status: { ...READY_INPUT, pending: true } });
    await settle();
    assert.equal(root.querySelector("small")?.textContent, "Refreshing.");
    assert.equal(root.querySelector("input"), input);
    enabled.publish({ value: false, status: READY_INPUT });
    source.publish({ status: failed });
    await settle();
    assert.equal(root.querySelector("h2")?.textContent, "Disabled");
    assert.equal(root.querySelector("p"), null);
  });

  it("keeps returned status and name copies separate from internal state without freezing", () => {
    const { inputs } = create();
    const product = inputs.source("product");
    product.publish({ status: failed });
    const status = inputs.status("product");
    Reflect.set(status, "ready", true);
    Reflect.set(status.error!, "message", "Mutated by caller");
    Reflect.set(product.current().status, "pending", true);
    (inputs.names as string[]).push("undeclared");
    assert.deepEqual(inputs.status("product"), failed);
    assert.throws(() => inputs.source("undeclared"), TypeError);
    assert.equal(Object.isFrozen(status), false);
  });

  it("renders pending, named failure, accepted data and refreshing without replacing success content", async () => {
    const { root, host, inputs } = create();
    const product = inputs.source("product");
    assert.equal(product.publish({ status: pending }), true);
    await settle();
    assert.equal(root.querySelector("i")?.textContent, "Loading.");
    assert.equal(product.publish({ status: failed }), true);
    await settle();
    assert.equal(root.querySelector("p")?.textContent, "Offline");
    assert.equal(product.publish({ value: { name: "Coffee" }, status: READY_INPUT }), true);
    await settle();
    assert.equal(root.querySelector("h2")?.textContent, "Coffee");
    assert.deepEqual(host.props.product!.value, { name: "Coffee" });
    const input = root.querySelector("input")!;
    input.value = "an edit";
    assert.equal(product.publish({ value: { name: "Coffee" }, status: { ...READY_INPUT, pending: true } }), true);
    await settle();
    assert.equal(root.querySelector("small")?.textContent, "Refreshing.");
    assert.equal(root.querySelector("input"), input);
    assert.equal(input.value, "an edit");
    assert.equal(product.publish({ value: { name: "Coffee" }, status: { ...READY_INPUT, error: failed.error } }), true);
    await settle();
    assert.equal(root.querySelector("h2")?.textContent, "Coffee");
    assert.equal(root.querySelector("p"), null, "a failed refresh retains usable content");
  });

  it("preserves caller ownership, including null, and rejects stale or invalid producer writes", async () => {
    const { root, inputs } = create();
    const product = inputs.source("product");
    assert.equal(product.publish({ value: { name: "Coffee" }, status: READY_INPUT }), true);
    assert.equal(product.publish({ value: { name: 7 }, status: READY_INPUT }), false);
    assert.deepEqual(inputs.read("product"), { name: "Coffee" });
    assert.equal(product.publish({ value: null, status: READY_INPUT }), true);
    assert.equal(inputs.status("product").ready, true);
    assert.equal(inputs.supplied("product"), false);
    componentRegistry.update(root, { product: { name: "Fixture" } });
    assert.equal(inputs.supplied("product"), true);
    assert.equal(product.publish({ value: { name: "Remote" }, status: READY_INPUT }), false);
    componentRegistry.update(root, { product: null });
    assert.equal(inputs.supplied("product"), true);
    assert.equal(product.publish({ value: { name: "Remote" }, status: READY_INPUT }), false);
    await settle();
    assert.notEqual(root.querySelector("input"), null, "a supplied nullable null is available");
    componentRegistry.update(root, { product: undefined });
    assert.equal(inputs.supplied("product"), false);
    assert.equal(product.publish({ value: { name: "Remote" }, status: READY_INPUT }), true);
    product.dispose();
    const replacement = inputs.source("product");
    assert.equal(product.publish({ value: { name: "Obsolete" }, status: READY_INPUT }), false);
    assert.equal(replacement.publish({ value: { name: "Replacement" }, status: READY_INPUT }), true);
    await settle();
    assert.equal(root.querySelector("h2")?.textContent, "Replacement");
  });

  it("does not transfer ownership after a refused caller attempt", () => {
    const { root, host, inputs } = create();
    const product = inputs.source("product");
    product.publish({ value: { name: "Coffee" }, status: READY_INPUT });
    componentRegistry.update(root, { product: { name: 7 } });
    assert.deepEqual(host.props.product!.inputValue, { name: 7 });
    assert.equal(host.props.product!.validity.valid, false);
    assert.equal(inputs.supplied("product"), false);
    assert.equal(product.publish({ value: { name: "Fresh" }, status: READY_INPUT }), true);
    assert.deepEqual(inputs.read("product"), { name: "Fresh" });
    assert.deepEqual(host.props.product!.inputValue, { name: 7 }, "source updates retain a refused caller attempt for validation");
    assert.equal(host.props.product!.validity.valid, false);
  });

  it("keeps normal constraint validity separate from typed-value acceptance", () => {
    const { host, inputs } = create('<template component="x-input"><defs><prop name="amount" type="number" min="1" max="3">Amount.</prop></defs><section><b $await="$amount">{$amount}</b></section></template>');
    const amount = inputs.source("amount");
    assert.equal(amount.publish({ value: 4, status: READY_INPUT }), true);
    assert.equal(inputs.read("amount"), 4);
    assert.equal(inputs.status("amount").ready, true);
    assert.equal(host.props.amount!.validity.rangeOverflow, true);
    assert.equal(amount.publish({ value: "invalid", status: READY_INPUT }), false);
    assert.equal(inputs.read("amount"), 4);
  });

  it("watches source eligibility without rerunning for source results or fixture value edits", async () => {
    const { root, inputs } = create();
    const product = inputs.source("product");
    const ownership: boolean[] = [];
    const stop = inputs.watch(() => { ownership.push(inputs.supplied("product")); });
    product.publish({ value: { name: "Coffee" }, status: READY_INPUT });
    await settle();
    assert.deepEqual(ownership, [false]);
    componentRegistry.update(root, { product: { name: "Fixture" } });
    await settle();
    assert.deepEqual(ownership, [false, true]);
    componentRegistry.update(root, { product: { name: "Edited fixture" } });
    await settle();
    assert.deepEqual(ownership, [false, true]);
    componentRegistry.update(root, { product: undefined });
    await settle();
    assert.deepEqual(ownership, [false, true, false]);
    stop();
    componentRegistry.update(root, { product: { name: "After stop" } });
    await settle();
    assert.deepEqual(ownership, [false, true, false]);
  });

  it("does not subscribe a producer to reads performed while publishing its output", async () => {
    const { inputs } = create();
    const product = inputs.source("product");
    let runs = 0;
    const stop = inputs.watch(() => {
      runs += 1;
      if (runs === 1) product.publish({ value: { name: "Coffee" }, status: READY_INPUT });
    });
    await settle();
    assert.equal(runs, 1);
    stop();
  });

  it("carries pending ownership, public failure and refresh status through a child binding", async () => {
    const parent = '<template component="x-input"><defs><prop name="product" type="object({ name: string })">Product.</prop><prop name="enabled" type="boolean" default="true">Enabled.</prop></defs><section><x-child from:product="$enabled ? $product : { name: \'Disabled\' }"></x-child></section></template>';
    const child = '<template component="x-child"><defs><prop name="product" type="object({ name: string })">Product.</prop></defs><article><b $await="binding of $product">{$product.name}<small $if="$binding.pending">Refreshing.</small></b><p $error="problem">{$problem.message}</p><i $else>Loading.</i></article></template>';
    const { root, inputs } = create(parent, [child]);
    const childInputs = componentInputs(getComponentHost(root.querySelector("article")!)!);
    const childSource = childInputs.source("product");
    assert.equal(childInputs.supplied("product"), true);
    assert.equal(childSource.publish({ value: { name: "Unwanted default" }, status: READY_INPUT }), false);
    const product = inputs.source("product");
    product.publish({ status: pending });
    await settle();
    assert.equal(childInputs.status("product").pending, true);
    assert.equal(root.querySelector("i")?.textContent, "Loading.");
    product.publish({ status: failed });
    await settle();
    assert.equal(root.querySelector("p")?.textContent, "Offline");
    product.publish({ value: { name: "Coffee" }, status: READY_INPUT });
    await settle();
    const content = root.querySelector("b");
    assert.equal(content?.textContent, "Coffee");
    product.publish({ value: { name: "Coffee" }, status: { ...READY_INPUT, pending: true } });
    await settle();
    assert.equal(root.querySelector("b"), content);
    assert.equal(root.querySelector("small")?.textContent, "Refreshing.");
    product.publish({ status: pending });
    await settle();
    assert.equal(root.querySelector("b"), null, "a changed unavailable input clears the old content");
    assert.equal(childInputs.supplied("product"), true);
    const enabled = inputs.source("enabled");
    enabled.publish({ value: false, status: READY_INPUT });
    product.publish({ status: failed });
    await settle();
    assert.equal(root.querySelector("b")?.textContent, "Disabled");
    assert.equal(root.querySelector("p"), null);
    enabled.publish({ value: true, status: READY_INPUT });
    await settle();
    assert.equal(root.querySelector("p")?.textContent, "Offline");
  });

  const snapshots: [string, InputSnapshot][] = [
    ["pending", { status: pending }],
    ["initial failure", { status: failed }],
    ["refreshing", { value: { name: "Coffee" }, status: { ...READY_INPUT, pending: true } }],
    ["failed refresh", { value: { name: "Coffee" }, status: { ...READY_INPUT, error: failed.error } }],
  ];
  for (const [name, snapshot] of snapshots) {
    it(`restores ${name} and source ownership when adopting rendered output`, async () => {
      const server = create();
      server.inputs.source("product").publish(snapshot);
      await settle();
      const control = server.root.querySelector("input");
      if (control !== null) control.value = "edited before adoption";
      const html = serializeRenderedForm(server.document.body);
      const client = create(source, [], html);
      await settle();
      assert.deepEqual(client.inputs.status("product"), snapshot.status);
      assert.equal(client.inputs.supplied("product"), false, "a restored source result is not a caller override");
      if (client.existingInput !== null) {
        assert.equal(client.root.querySelector("input"), client.existingInput);
        assert.equal(client.existingInput.value, "edited before adoption");
      }
      assert.equal(client.inputs.source("product").publish({ value: { name: "Resumed" }, status: READY_INPUT }), true);
      await settle();
      assert.equal(client.root.querySelector("h2")?.textContent, "Resumed");
    });
  }

  it("restores an explicit null caller override without making its source eligible", async () => {
    const server = create();
    componentRegistry.update(server.root, { product: null });
    await settle();
    const client = create(source, [], serializeRenderedForm(server.document.body));
    assert.equal(client.inputs.status("product").ready, true);
    assert.equal(client.inputs.supplied("product"), true);
    assert.equal(client.inputs.read("product"), null);
    assert.equal(client.inputs.source("product").publish({ value: { name: "Unwanted default" }, status: READY_INPUT }), false);
  });
});
