import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { JSDOM } from "jsdom";
import { afterEach, describe, it, vi } from "vitest";
import { componentInputs, READY_INPUT, copyStateSeed } from "../src/inputs.js";
import { componentRegistry, getComponentHost, lowerDocument, registerComponentDefinitions, serializeRenderedForm } from "../src/runtime.js";
import { parseComponent } from "../src/source-parser.js";

const source = '<template component="x-seed"><defs><prop name="product" type="object({ name: string })">Product.</prop><state name="draft" type="string" from="$product.name"></state><computed name="label" from="concat($draft, \'!\')"></computed></defs><section><template $await="binding of $draft"><b>{$draft}</b></template><p $error="problem">{$problem.message}</p><i $else>Waiting.</i><input bind:value="$draft"></section></template>';
const windows: JSDOM[] = [];
function create(definition = source, html = "<x-seed></x-seed>") {
  const dom = new JSDOM(`<!doctype html><html><head></head><body>${html}</body></html>`, { url: "https://example.test/" });
  windows.push(dom);
  for (const name of ["Node", "Element", "HTMLElement", "Text", "Comment", "HTMLTemplateElement", "HTMLInputElement", "HTMLTextAreaElement", "HTMLSelectElement", "HTMLOptionElement", "HTMLFormElement", "MutationObserver", "Event", "CustomEvent", "KeyboardEvent", "MouseEvent"]) vi.stubGlobal(name, Reflect.get(dom.window, name));
  registerComponentDefinitions([parseComponent(definition)], dom.window.document);
  lowerDocument(dom.window.document, { connect: false });
  const root = dom.window.document.querySelector("section")!;
  const host = getComponentHost(root)!;
  return { dom, root, host, port: componentInputs(host) };
}
const tick = async () => { for (let index = 0; index < 12; index += 1) await Promise.resolve(); };
afterEach(() => { for (const dom of windows.splice(0)) dom.window.close(); vi.unstubAllGlobals(); });

describe("one-time state initialization", () => {
  it("parses a seed separately from literal state and rejects ambiguous or missing expressions", () => {
    const state = parseComponent(source).declarations!.find(declaration => declaration.kind === "state")!;
    assert.equal(state.kind, "state");
    if (state.kind !== "state") return;
    assert.equal(state.expression, undefined);
    assert.equal(state.initializer?.source, "$product.name");
    assert.throws(() => parseComponent(source.replace('from="$product.name"', 'from=""')), /nonempty from/);
    assert.throws(() => parseComponent(source.replace('from="$product.name"', 'from="$product.name" value="literal"')), /either a literal/);
    assert.throws(() => parseComponent(source.replace('from="$product.name"', 'from="$missing"')), /not declared|undeclared/);
  });

  it("seeds the declarative first frame synchronously when its typed input is available", () => {
    const { root, host, port } = create(source, '<x-seed product=\'{"name":"Coffee"}\'></x-seed>');
    assert.equal(root.querySelector("b")?.textContent, "Coffee");
    assert.equal(host.state.draft, "Coffee");
    assert.equal(host.state.label, "Coffee!");
    assert.deepEqual(port.status("draft"), READY_INPUT);
    componentRegistry.update(root, { product: { name: "Tea" } });
    assert.equal(host.state.draft, "Coffee");
  });

  it("waits with prerequisite activity/errors and becomes independent after the first value", async () => {
    const { root, host, port } = create();
    const product = port.source("product");
    assert.equal(host.state.draft, undefined);
    assert.equal(root.querySelector("i")?.textContent, "Waiting.");
    product.publish({ status: { ready: false, pending: true, error: null, stale: false } }); await tick();
    assert.equal(port.status("draft").pending, true);
    product.publish({ status: { ready: false, pending: false, error: { name: "Error", message: "Offline" }, stale: false } }); await tick();
    assert.equal(root.querySelector("p")?.textContent, "Offline");
    product.publish({ value: { name: "Coffee" }, status: READY_INPUT }); await tick();
    assert.equal(host.state.draft, "Coffee");
    host.state.draft = "Edited";
    product.publish({ value: { name: "Tea" }, status: { ...READY_INPUT, pending: true } }); await tick();
    assert.equal(host.state.draft, "Edited");
    assert.deepEqual(port.status("draft"), READY_INPUT);
    product.dispose();
  });

  it("seeds from a prop default when the caller explicitly supplies null", () => {
    const definition = source.replace('name="product" type="object({ name: string })"', 'name="product" type="object({ name: string })" default="{ name: \'Default\' }"');
    const { root, host, port } = create(definition);
    componentRegistry.update(root, { product: null });
    assert.deepEqual(port.read("product"), { name: "Default" });
    assert.equal(port.supplied("product"), true);
    assert.equal(host.state.draft, "Default");
  });

  it("claims an early bound-control edit, including an empty string", async () => {
    const { root, dom, host, port } = create();
    const input = root.querySelector("input")!;
    input.value = ""; input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    await tick();
    assert.equal(host.state.draft, "");
    port.source("product").publish({ value: { name: "Remote" }, status: READY_INPUT }); await tick();
    assert.equal(host.state.draft, "");
    assert.deepEqual(port.status("draft"), READY_INPUT);
  });

  it("claims an accepted same-value null write before the seed arrives", async () => {
    const { host, port } = create(source.replace('name="draft" type="string"', 'name="draft"'));
    host.state.draft = null;
    assert.deepEqual(port.status("draft"), READY_INPUT);
    port.source("product").publish({ value: { name: "Remote" }, status: READY_INPUT }); await tick();
    assert.equal(host.state.draft, null);
  });

  it("refuses invalid early writes without claiming the pending cell", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { host, port } = create();
      host.state.draft = 7;
      assert.equal(host.state.draft, undefined);
      assert.equal(port.status("draft").ready, false);
      port.source("product").publish({ value: { name: "Remote" }, status: READY_INPUT }); await tick();
      assert.equal(host.state.draft, "Remote");
    } finally { warn.mockRestore(); }
  });

  it("copies record/list seeds so nested edits do not mutate the input", async () => {
    const definition = source.replace('name="draft" type="string" from="$product.name"', 'name="draft" type="object({ name: string })" from="$product"')
      .replace("<b>{$draft}</b>", "<b>{$draft.name}</b>").replace('<input bind:value="$draft">', "");
    const { host, port } = create(definition);
    const product = port.source("product");
    product.publish({ value: { name: "Remote" }, status: READY_INPUT });
    (host.state.draft as { name: string }).name = "Early edit";
    product.publish({ value: { name: "New remote" }, status: READY_INPUT }); await tick();
    assert.equal((host.state.draft as { name: string }).name, "Early edit");
    assert.deepEqual(port.read("product"), { name: "New remote" });
    product.dispose();
  });

  it("copies ordinary graphs, preserving shared references, holes and opaque identity without freezing", () => {
    const leaf = { value: 1 }; const native = new Date();
    const values: unknown[] = []; values.length = 2;
    const input = { left: leaf, right: leaf, values, native };
    const copy = copyStateSeed(input);
    assert.notEqual(copy, input); assert.notEqual(copy.left, leaf); assert.equal(copy.left, copy.right);
    assert.equal(copy.native, native); assert.equal(0 in copy.values, false);
    assert.equal(Object.isFrozen(copy), false);
    copy.left.value = 2; assert.equal(leaf.value, 1);
    const cycle: { next?: unknown } = {}; cycle.next = cycle;
    const copiedCycle = copyStateSeed(cycle);
    assert.equal(copiedCycle.next, copiedCycle);
  });

  it("copies foreign-realm records and graphs while preserving opaque identities", () => {
    const foreign = runInNewContext(`(() => {
      const shared = { name: "Original" }; class Opaque { value = 1; }
      const graph = { left: shared, right: shared, values: [shared], opaque: new Opaque() };
      graph.self = graph; return graph;
    })()`) as { left: { name: string }; right: { name: string }; values: { name: string }[]; opaque: object; self: unknown };
    const copy = copyStateSeed(foreign);
    assert.notEqual(copy, foreign); assert.notEqual(copy.left, foreign.left); assert.notEqual(copy.values, foreign.values);
    assert.equal(copy.left, copy.right); assert.equal(copy.values[0], copy.left); assert.equal(copy.self, copy);
    assert.equal(Object.getPrototypeOf(copy), Object.getPrototypeOf(foreign));
    copy.left.name = "Edited"; assert.equal(foreign.left.name, "Original");
    assert.equal(copy.opaque, foreign.opaque);
    class LocalOpaque { name = "Kept"; }
    const opaque = new LocalOpaque(); assert.equal(copyStateSeed(opaque), opaque);
    const native = new Date(); assert.equal(copyStateSeed(native), native);
    assert.equal(Object.isFrozen(copy), false);
  });

  it("retains waiting and already edited ownership through rendered-form adoption", async () => {
    for (const edited of [false, true]) {
      const server = create();
      if (edited) server.host.state.draft = "Kept";
      const html = serializeRenderedForm(server.dom.window.document.body);
      const client = create(source, html);
      assert.equal(client.host.state.draft, edited ? "Kept" : undefined);
      client.port.source("product").publish({ value: { name: "Remote" }, status: READY_INPUT }); await tick();
      assert.equal(client.host.state.draft, edited ? "Kept" : "Remote");
    }
  });

  it("waits for current data when its first input is retained stale data", async () => {
    const { host, port } = create();
    const product = port.source("product");
    product.publish({ value: { name: "Old" }, status: { ...READY_INPUT, pending: true, stale: true } }); await tick();
    assert.equal(host.state.draft, undefined);
    assert.equal(port.status("draft").ready, false);
    product.publish({ value: { name: "Current" }, status: READY_INPUT }); await tick();
    assert.equal(host.state.draft, "Current");
    product.dispose();
  });

  it("resolves forward initializer dependencies and diagnoses declaration cycles", () => {
    const definition = source.replace('name="draft" type="string" from="$product.name"', 'name="draft" type="string" from="$later"')
      .replace('</defs>', '<state name="later" type="string" from="$product.name"></state></defs>');
    assert.equal(create(definition, '<x-seed product=\'{"name":"Forward"}\'></x-seed>').host.state.draft, "Forward");
    assert.throws(() => create(definition.replace('name="later" type="string" from="$product.name"', 'name="later" type="string" from="$draft"')), /depends on itself|cycle/);
  });
});
