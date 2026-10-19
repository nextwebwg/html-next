import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { afterEach, beforeAll, describe, it, vi } from "vitest";
import { generateComponent } from "../src/generate.js";
import { componentInputs, READY_INPUT } from "../src/inputs.js";
import { componentRegistry, getComponentHost, serializeRenderedForm } from "../src/runtime.js";
import { parseComponent } from "../src/source-parser.js";
import { compiledFixtures } from "./hydration-fixtures.js";
import { BindingScope } from "../src/bindings.js";

const source = '<template component="x-await"><defs><prop name="product" type="object({ name: string })">Product.</prop></defs><section><template $await="binding of $product"><h2>{$product.name}</h2><input value="initial"><small $if="$binding.pending">Refreshing.</small></template><p $error="problem">{$problem.message}</p><i $else>Loading.</i></section></template>';
const pending = { ready: false, pending: true, error: null, stale: false };
const failed = { ready: false, pending: false, error: { name: "NetworkError", message: "Offline" }, stale: false };
let code: string;
let treeCode: string;
let constructorCode: string;
let derivedCode: string;
let defaultCode: string;
let selectedCode: string;
let contextCode: string;
let revision = 0;
const windows: JSDOM[] = [];
beforeAll(async () => {
  const artifact = generateComponent(parseComponent(source), { hydrate: true }).find(artifact => artifact.path === "vanilla/XAwait.js")!;
  const result = await build({ stdin: { contents: artifact.content, resolveDir: fileURLToPath(new URL("../", import.meta.url)), loader: "js" },
    bundle: true, format: "esm", platform: "browser", write: false, loader: { ".css": "empty" },
    alias: { "@nextwebwg/html-next/generated-runtime": fileURLToPath(new URL("../src/generated-runtime.ts", import.meta.url)) },
    plugins: [{ name: "fixture-css", setup(build) {
      build.onResolve({ filter: /\.css$/ }, args => ({ path: args.path, namespace: "fixture-css" }));
      build.onLoad({ filter: /.*/, namespace: "fixture-css" }, () => ({ contents: "", loader: "js" }));
    } }] });
  code = result.outputFiles[0]!.text;
  defaultCode = await compiledFixtures("esm", "", [
    parseComponent(source.replace('component="x-await"', 'component="x-default"')
      .replace('type="object({ name: string })"', 'type="object({ name: string })" default="{ name: \'Default\' }"')),
    parseComponent('<template component="x-default-parent"><defs><prop name="enabled" type="boolean" default="true">Enabled.</prop></defs><section><x-default from:product="$enabled ? { name: \'Fixture\' } : null"></x-default></section></template>'),
  ]);
  selectedCode = await compiledFixtures("esm", "", [
    parseComponent('<template component="x-selected-parent"><defs><prop name="incoming">Incoming.<type from="mode"><option value="text" type="string"></option><option value="number" type="number"></option></type></prop><prop name="mode" type="keyword" values="text, number" default="number">Mode.</prop></defs><section><x-selected from:value="$incoming" from:mode="$mode"></x-selected></section></template>'),
    parseComponent('<template component="x-selected"><defs><prop name="value">Value.<type from="mode"><option value="text" type="string"></option><option value="number" type="number"></option></type></prop><prop name="mode" type="keyword" values="text, number" default="number">Mode.</prop></defs><output from:data-mode="$mode" from:data-value="$value">{$value}</output></template>'),
  ]);
  treeCode = await compiledFixtures("esm", "", [
    parseComponent('<template component="x-parent"><defs><prop name="product" type="object({ name: string })">Product.</prop><prop name="enabled" type="boolean" default="true">Enabled.</prop></defs><section><x-child from:product="$enabled ? $product : { name: \'Disabled\' }"></x-child></section></template>'),
    parseComponent(source.replace('component="x-await"', 'component="x-child"').replace("<section>", "<article>").replace("</section>", "</article>")),
  ]);
  constructorCode = await compiledFixtures("esm", "", [parseComponent('<template component="x-constructor"><defs><prop name="constructor" type="string">Value.</prop></defs><section><b $await="$constructor">{$constructor}</b><p $else>Loading.</p></section></template>')]);
  contextCode = await compiledFixtures("esm", "", [
    parseComponent('<template component="x-context-parent"><defs><prop name="id" type="integer" default="1">Id.</prop><state name="query" type="integer" value="5"></state></defs><section><b>{$id}</b><x-context-child></x-context-child></section></template>'),
    parseComponent('<template component="x-context-child"><defs><prop name="result" type="integer">Result.</prop><context name="query" from="x-context-parent" as="parentQuery"></context></defs><article>{$result}</article></template>'),
  ]);
  derivedCode = await compiledFixtures("esm", "", [parseComponent(source.replace('component="x-await"', 'component="x-derived"')
    .replace('</defs>', '<prop name="enabled" type="boolean" default="false">Enabled.</prop><prop name="driven" type="string">Driven.</prop><state name="query" type="integer" value="0"></state><computed name="label" type="string" from="$enabled ? concat($product.name, \'!\') : \'Disabled\'"></computed><computed name="result" type="string" from="concat($label, \'?\')"></computed><computed name="key" type="string" from="concat($result, \'/\', $query)"></computed></defs>')
    .replace('binding of $product', 'binding of $result').replace('{$product.name}', '{$result}'))]);
});
afterEach(() => { for (const dom of windows.splice(0)) dom.window.close(); vi.unstubAllGlobals(); });
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
async function create(html = "", kind: "await" | "tree" | "constructor" | "derived" | "default" | "defaultTree" | "selected" | "context" = "await") {
  const dom = new JSDOM(`<!doctype html><html><head></head><body>${html}</body></html>`, { url: "https://example.test/" });
  windows.push(dom);
  for (const name of ["document", "Node", "Element", "HTMLElement", "Text", "Comment", "HTMLTemplateElement", "HTMLInputElement", "HTMLTextAreaElement", "HTMLSelectElement", "HTMLOptionElement", "HTMLFormElement", "MutationObserver", "Event", "CustomEvent", "KeyboardEvent", "MouseEvent"]) {
    vi.stubGlobal(name, Reflect.get(dom.window, name));
  }
  const original = dom.window.document.querySelector("input");
  const fixture = {
    await: { source: code, tag: "x-await" }, tree: { source: treeCode, tag: "x-parent" },
    constructor: { source: constructorCode, tag: "x-constructor" }, derived: { source: derivedCode, tag: "x-derived" },
    default: { source: defaultCode, tag: "x-default" }, defaultTree: { source: defaultCode, tag: "x-default-parent" },
    selected: { source: selectedCode, tag: "x-selected-parent" },
    context: { source: contextCode, tag: "x-context-parent" },
  }[kind];
  const module = await import(`data:text/javascript;base64,${Buffer.from(`${fixture.source}\n// ${revision++}`).toString("base64")}`) as {
    createXAwait(props?: object, html?: undefined, root?: Element): Element;
    factories: Record<string, (props?: object, html?: undefined, root?: Element) => Element>;
  };
  const factory = kind === "await" ? module.createXAwait : module.factories[fixture.tag]!;
  const root = factory({}, undefined, dom.window.document.querySelector("section") ?? undefined);
  if (!root.isConnected) dom.window.document.body.append(root);
  await flush();
  const host = getComponentHost(root)!;
  return { root, host, inputs: componentInputs(host), document: dom.window.document, original };
}

describe("compiled native await input boundary", () => {
  it("selects a declared context alias without copying the provider's state", async () => {
    const { root, host } = await create("", "context");
    const child = root.querySelector("article")!;
    const port = componentInputs(getComponentHost(child)!);
    const scope = new BindingScope(port, { result: { input: (_props, { state }) => state.parentQuery, load: value => value + 1 } }, { phase: "request" });
    try {
      scope.activate(); await scope.settled(); await flush();
      assert.equal(child.textContent, "6");
      host.state.query = 10; await flush(); await scope.settled(); await flush();
      assert.equal(child.textContent, "11");
      assert.equal(port.read("parentQuery"), 10);
      assert.throws(() => port.source("parentQuery"), /not a declared prop/);
    } finally { scope.dispose(); }
  });

  it("selects state and computed declarations through the compiled owner's availability scope", async () => {
    const { root, inputs, host } = await create("", "derived");
    const keys: string[] = [];
    const scope = new BindingScope(inputs, { driven: { input: (_props, { state }) => state.key, load: key => { keys.push(key); return key; } } }, { phase: "request" });
    const product = inputs.source("product");
    try {
      assert.ok(inputs.readNames.includes("query")); assert.ok(inputs.readNames.includes("key"));
      assert.throws(() => inputs.source("query"), /not a declared prop/);
      scope.activate(); await scope.settled();
      assert.equal(inputs.read("driven"), "Disabled?/0");
      componentRegistry.update(root, { enabled: true });
      product.publish({ status: pending }); await flush(); await scope.settled();
      assert.equal(inputs.status("driven").ready, false);
      assert.equal(inputs.status("driven").pending, true);
      product.publish({ value: { name: "Coffee" }, status: READY_INPUT }); await flush(); await scope.settled();
      assert.equal(inputs.read("driven"), "Coffee!?/0");
      host.state.query = 1; await flush(); await scope.settled();
      assert.equal(inputs.read("driven"), "Coffee!?/1");
      product.publish({ value: { name: "Coffee" }, status: { ...READY_INPUT, pending: true } }); await flush(); await scope.settled();
      assert.equal(inputs.status("driven").pending, true);
      assert.deepEqual(keys, ["Disabled?/0", "Coffee!?/0", "Coffee!?/1"]);
    } finally { product.dispose(); scope.dispose(); }
  });

  it("adopts prepared successes and failures and detects a fixture edited before the driver loads", async () => {
    for (const result of ["success", "failure", "fixture"] as const) {
      let reads = 0;
      const providers = { product: { input: () => 1, load: () => {
        reads += 1; if (result === "failure") throw new Error("Offline"); return { name: `Read ${reads}` };
      } } };
      const server = await create();
      const preparation = new BindingScope(server.inputs, providers, { phase: "request", source: "build-a" });
      preparation.activate(); await preparation.settled(); await flush();
      const snapshot = preparation.snapshot();
      const html = serializeRenderedForm(server.document.body);
      preparation.dispose();
      const client = await create(html);
      assert.equal(client.inputs.revision("product"), snapshot.reads.product!.revision);
      if (result === "fixture") {
        componentRegistry.update(client.root, { product: { name: "Fixture" } });
        componentRegistry.update(client.root, { product: undefined });
      }
      const activation = new BindingScope(client.inputs, providers, { phase: "browser", source: "build-a", snapshot });
      try {
        activation.activate(); await activation.settled(); await flush();
        assert.equal(reads, result === "fixture" ? 2 : 1);
        assert.equal(client.root.querySelector("h2")?.textContent, result === "failure" ? undefined : result === "fixture" ? "Read 2" : "Read 1");
        assert.equal(client.inputs.status("product").error?.message, result === "failure" ? "Offline" : undefined);
      } finally { activation.dispose(); }
    }
  });

  it("prepares providers and invalidates retained data after a detached fixture override", async () => {
    const { root, inputs } = await create();
    let reads = 0;
    const scope = new BindingScope(inputs, { product: { input: () => 1, load: () => ({ name: `Read ${++reads}` }) } }, { phase: "request" });
    try {
      scope.activate(); await scope.settled(); await flush();
      assert.equal(root.querySelector("h2")?.textContent, "Read 1");
      scope.deactivate();
      componentRegistry.update(root, { product: { name: "Fixture" } });
      componentRegistry.update(root, { product: undefined });
      scope.activate(); await scope.settled(); await flush();
      assert.equal(root.querySelector("h2")?.textContent, "Read 2");
    } finally { scope.dispose(); }
  });

  it("accepts a bound selector before its dependent value regardless of attribute order", async () => {
    const { root } = await create("", "selected");
    for (const [mode, incoming] of [["number", 2], ["text", "hello"], ["number", 4]] as const) {
      componentRegistry.update(root, { mode, incoming });
      await flush();
      const output = root.querySelector("output")!;
      assert.equal(output.getAttribute("data-mode"), mode);
      assert.equal(output.getAttribute("data-value"), String(incoming));
      assert.equal(getComponentHost(output)!.props.value!.validity.valid, true);
    }
  });

  it("does not notify status readers for an equivalent publication", async () => {
    const { inputs, host } = await create();
    const product = inputs.source("product");
    let runs = 0;
    const stop = inputs.watch(() => { inputs.status("product"); runs += 1; });
    let rawRuns = 0;
    const stopRaw = inputs.watch(() => { void host.props.product!.inputValue; rawRuns += 1; });
    product.publish({ status: pending });
    await flush();
    const afterPending = runs;
    const rawAfterPending = rawRuns;
    product.publish({ status: { ...pending } });
    await flush();
    assert.equal(runs, afterPending);
    assert.equal(rawRuns, rawAfterPending);
    product.publish({ status: failed });
    await flush();
    const afterError = runs;
    assert.equal(afterError, afterPending + 1);
    product.publish({ status: { ...failed, error: { ...failed.error } } });
    await flush();
    assert.equal(runs, afterError);
    assert.equal(rawRuns, rawAfterPending, "status-only failure does not rewrite raw input");
    stop(); stopRaw();
  });

  it("resets a child's default when a parent expression becomes null", async () => {
    const { root, inputs } = await create("", "defaultTree");
    assert.equal(root.querySelector("h2")?.textContent, "Fixture");
    inputs.source("enabled").publish({ value: false, status: READY_INPUT });
    await flush();
    assert.equal(root.querySelector("h2")?.textContent, "Default");
  });

  it("resolves null source and caller inputs to the default and preserves it during adoption", async () => {
    const server = await create("", "default");
    const product = server.inputs.source("product");
    product.publish({ value: { name: "Remote" }, status: READY_INPUT });
    product.publish({ value: null, status: READY_INPUT });
    await flush();
    assert.equal(server.root.querySelector("h2")?.textContent, "Default");
    componentRegistry.update(server.root, { product: { name: "Fixture" } });
    componentRegistry.update(server.root, { product: null });
    await flush();
    assert.equal(server.root.querySelector("h2")?.textContent, "Default");
    assert.equal(server.inputs.supplied("product"), true);
    assert.equal(server.host.props.product!.validity.valid, true);
    const client = await create(serializeRenderedForm(server.document.body), "default");
    assert.deepEqual(client.inputs.read("product"), { name: "Default" });
    assert.equal(client.inputs.supplied("product"), true);
    assert.equal(client.inputs.source("product").publish({ value: { name: "Remote" }, status: READY_INPUT }), false);
  });

  it("tracks actual computed prerequisites through a derived chain and status-only refreshes", async () => {
    const { root, inputs } = await create("", "derived");
    assert.equal(root.querySelector("h2")?.textContent, "Disabled?");
    const product = inputs.source("product");
    const enabled = inputs.source<boolean>("enabled");
    enabled.publish({ value: true, status: READY_INPUT });
    product.publish({ status: pending });
    await flush();
    assert.equal(root.querySelector("i")?.textContent, "Loading.");
    product.publish({ status: failed });
    await flush();
    assert.equal(root.querySelector("p")?.textContent, "Offline");
    product.publish({ value: { name: "Coffee" }, status: READY_INPUT });
    await flush();
    assert.equal(root.querySelector("h2")?.textContent, "Coffee!?");
    const control = root.querySelector("input");
    product.publish({ value: { name: "Coffee" }, status: { ...READY_INPUT, pending: true } });
    await flush();
    assert.equal(root.querySelector("small")?.textContent, "Refreshing.");
    assert.equal(root.querySelector("input"), control);
    enabled.publish({ value: false, status: READY_INPUT });
    await flush();
    product.publish({ status: failed });
    await flush();
    assert.equal(root.querySelector("h2")?.textContent, "Disabled?");
    assert.equal(root.querySelector("p"), null);
    assert.equal(root.querySelector("small"), null);
  });

  it("renders pending, named failure, data and retained refreshing content", async () => {
    const { root, inputs } = await create();
    assert.equal(root.querySelector("i")?.textContent, "Loading.");
    const product = inputs.source("product");
    product.publish({ status: pending });
    await flush();
    product.publish({ status: failed });
    await flush();
    assert.equal(root.querySelector("p")?.textContent, "Offline");
    product.publish({ value: { name: "Coffee" }, status: READY_INPUT });
    await flush();
    assert.equal(root.querySelector("h2")?.textContent, "Coffee");
    const control = root.querySelector("input")!;
    control.value = "an edit";
    product.publish({ value: { name: "Coffee" }, status: { ...READY_INPUT, pending: true } });
    await flush();
    assert.equal(root.querySelector("small")?.textContent, "Refreshing.");
    assert.equal(root.querySelector("input"), control);
    assert.equal(control.value, "an edit");
    product.publish({ value: { name: "Coffee" }, status: { ...READY_INPUT, error: failed.error } });
    await flush();
    assert.equal(root.querySelector("h2")?.textContent, "Coffee");
    assert.equal(root.querySelector("p"), null);
    product.publish({ status: pending });
    await flush();
    assert.equal(root.querySelector("h2"), null);
    assert.equal(root.querySelector("i")?.textContent, "Loading.");
  });

  it("honors caller overrides and preserves invalid attempted input when its source continues", async () => {
    const { root, host, inputs } = await create();
    const product = inputs.source("product");
    product.publish({ value: { name: "Coffee" }, status: READY_INPUT });
    componentRegistry.update(root, { product: { name: 7 } });
    assert.equal(inputs.supplied("product"), false);
    assert.equal(product.publish({ value: { name: "Fresh" }, status: READY_INPUT }), true);
    assert.deepEqual(host.props.product!.inputValue, { name: 7 });
    assert.equal(host.props.product!.validity.valid, false);
    componentRegistry.update(root, { product: null });
    assert.equal(inputs.status("product").ready, true);
    assert.equal(inputs.supplied("product"), true);
    assert.equal(product.publish({ value: { name: "Unwanted" }, status: READY_INPUT }), false);
    componentRegistry.update(root, { product: undefined });
    assert.equal(inputs.supplied("product"), false);
    assert.equal(product.publish({ value: { name: "Resumed" }, status: READY_INPUT }), true);
    await flush();
    assert.equal(root.querySelector("h2")?.textContent, "Resumed");
  });

  it("adopts public status and source ownership while keeping edited controls", async () => {
    const server = await create();
    server.inputs.source("product").publish({ value: { name: "Coffee" }, status: { ...READY_INPUT, pending: true } });
    await flush();
    server.root.querySelector("input")!.value = "an edit";
    const html = serializeRenderedForm(server.document.body);
    const client = await create(html);
    assert.equal(client.inputs.supplied("product"), false);
    assert.deepEqual(client.inputs.status("product"), { ...READY_INPUT, pending: true });
    assert.equal(client.root.querySelector("input"), client.original);
    assert.equal(client.original!.value, "an edit");
    client.inputs.source("product").publish({ value: { name: "Resumed" }, status: READY_INPUT });
    await flush();
    assert.equal(client.root.querySelector("h2")?.textContent, "Resumed");
  });

  it("forwards pending ownership, errors and status-only refreshes to a compiled child", async () => {
    const { root, inputs } = await create("", "tree");
    const child = componentInputs(getComponentHost(root.querySelector("article")!)!);
    assert.equal(child.supplied("product"), true);
    assert.equal(child.source("product").publish({ value: { name: "Unwanted default" }, status: READY_INPUT }), false);
    const product = inputs.source("product");
    product.publish({ status: pending });
    await flush();
    assert.deepEqual(child.status("product"), pending);
    product.publish({ status: failed });
    await flush();
    assert.equal(root.querySelector("p")?.textContent, "Offline");
    product.publish({ value: { name: "Coffee" }, status: READY_INPUT });
    await flush();
    const control = root.querySelector("input");
    product.publish({ value: { name: "Coffee" }, status: { ...READY_INPUT, pending: true } });
    await flush();
    assert.equal(root.querySelector("small")?.textContent, "Refreshing.");
    assert.equal(root.querySelector("input"), control);
    product.publish({ status: pending });
    await flush();
    assert.equal(root.querySelector("h2"), null);
    assert.equal(child.supplied("product"), true);
    const enabled = inputs.source("enabled");
    enabled.publish({ value: false, status: READY_INPUT });
    product.publish({ status: failed });
    await flush();
    assert.equal(root.querySelector("h2")?.textContent, "Disabled");
    assert.equal(root.querySelector("p"), null);
    enabled.publish({ value: true, status: READY_INPUT });
    await flush();
    assert.equal(root.querySelector("p")?.textContent, "Offline");
  });

  it("does not confuse declared input names with inherited object properties", async () => {
    const { root, inputs } = await create("", "constructor");
    assert.equal(inputs.status("constructor").ready, false);
    const source = inputs.source("constructor");
    assert.equal(source.publish({ value: "Coffee", status: READY_INPUT }), true);
    await flush();
    assert.equal(root.querySelector("b")?.textContent, "Coffee");
    componentRegistry.update(root, { constructor: "Fixture" });
    assert.equal(inputs.supplied("constructor"), true);
    assert.equal(source.publish({ value: "Unwanted default", status: READY_INPUT }), false);
  });
});
