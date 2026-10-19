import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { afterEach, beforeAll, describe, it, vi } from "vitest";
import { componentInputs, READY_INPUT } from "../src/inputs.js";
import { getComponentHost, serializeRenderedForm } from "../src/runtime.js";
import { parseComponent } from "../src/source-parser.js";
import { compiledFixtures } from "./hydration-fixtures.js";

const source = '<template component="x-seed"><defs><prop name="product" type="object({ name: string })">Product.</prop><state name="draft" type="string" from="$product.name"></state><state name="ordinary" type="integer" value="1"></state><computed name="label" from="concat($draft, \'!\')"></computed></defs><section><b $await="$draft">{$draft}</b><p $error="problem">{$problem.message}</p><i $else>Waiting.</i><input bind:value="$draft"></section></template>';
let code: string;
let objectCode: string;
let nullableCode: string;
let defaultCode: string;
let forwardCode: string;
let cycleCode: string;
let revision = 0;
const windows: JSDOM[] = [];
beforeAll(async () => {
  code = await compiledFixtures("esm", "", [parseComponent(source)]);
  objectCode = await compiledFixtures("esm", "", [parseComponent(source.replace('name="draft" type="string" from="$product.name"', 'name="draft" type="object({ name: string })" from="$product"').replace("{$draft}</b>", "{$draft.name}</b>").replace('<input bind:value="$draft">', ""))]);
  nullableCode = await compiledFixtures("esm", "", [parseComponent(source.replace('name="draft" type="string"', 'name="draft"'))]);
  defaultCode = await compiledFixtures("esm", "", [parseComponent(source.replace('name="product" type="object({ name: string })"', 'name="product" type="object({ name: string })" default="{ name: \'Default\' }"'))]);
  const forward = source.replace('from="$product.name"', 'from="$later"').replace('<computed name="label" from="concat($draft, \'!\')"></computed>', '<state name="later" type="string" from="$product.name"></state>');
  forwardCode = await compiledFixtures("esm", "", [parseComponent(forward)]);
  cycleCode = await compiledFixtures("esm", "", [parseComponent(forward.replace('name="later" type="string" from="$product.name"', 'name="later" type="string" from="$draft"'))]);
});
afterEach(() => { for (const dom of windows.splice(0)) dom.window.close(); vi.unstubAllGlobals(); });
const tick = async () => { for (let index = 0; index < 12; index += 1) await Promise.resolve(); };
async function create(props: object = {}, html = "", compiled = code) {
  const dom = new JSDOM(`<!doctype html><html><head></head><body>${html}</body></html>`, { url: "https://example.test/" });
  windows.push(dom);
  for (const name of ["document", "Node", "Element", "HTMLElement", "Text", "Comment", "HTMLTemplateElement", "HTMLInputElement", "HTMLTextAreaElement", "HTMLSelectElement", "HTMLOptionElement", "HTMLFormElement", "MutationObserver", "Event", "CustomEvent", "KeyboardEvent", "MouseEvent"]) vi.stubGlobal(name, Reflect.get(dom.window, name));
  const module = await import(`data:text/javascript;base64,${Buffer.from(`${compiled}\n// ${revision++}`).toString("base64")}`) as { factories: Record<string, (props: object, html?: undefined, root?: Element) => Element> };
  const root = module.factories["x-seed"]!(props, undefined, dom.window.document.querySelector("section") ?? undefined);
  if (!root.isConnected) dom.window.document.body.append(root);
  await tick();
  const host = getComponentHost(root)!;
  return { dom, root, host, port: componentInputs(host) };
}

describe("compiled one-time state initialization", () => {
  it("seeds the first frame and retains ordinary writable state", async () => {
    const { root, host, port } = await create({ product: { name: "Coffee" } });
    assert.equal(root.querySelector("b")?.textContent, "Coffee");
    assert.equal(host.state.draft, "Coffee");
    assert.equal(host.state.label, "Coffee!");
    assert.equal(host.state.ordinary, 1);
    assert.deepEqual(port.status("draft"), READY_INPUT);
  });

  it("waits through pending, failure and stale data, then ignores refreshes", async () => {
    const { root, host, port } = await create();
    const product = port.source("product");
    assert.equal(host.state.draft, undefined);
    assert.equal(root.querySelector("i")?.textContent, "Waiting.");
    product.publish({ status: { ready: false, pending: true, error: null, stale: false } }); await tick();
    assert.equal(port.status("draft").pending, true);
    product.publish({ status: { ready: false, pending: false, error: { name: "Error", message: "Offline" }, stale: false } }); await tick();
    assert.equal(root.querySelector("p")?.textContent, "Offline");
    product.publish({ value: { name: "Old" }, status: { ...READY_INPUT, pending: true, stale: true } }); await tick();
    assert.equal(host.state.draft, undefined);
    product.publish({ value: { name: "Coffee" }, status: READY_INPUT }); await tick();
    assert.equal(host.state.draft, "Coffee");
    host.state.draft = "Edited";
    product.publish({ value: { name: "Tea" }, status: READY_INPUT }); await tick();
    assert.equal(root.querySelector("b")?.textContent, "Edited");
    product.dispose();
  });

  it("uses a prop default for a caller's explicit null seed input", async () => {
    const { host, port } = await create({ product: null }, "", defaultCode);
    assert.equal(host.state.draft, "Default");
    assert.deepEqual(port.read("product"), { name: "Default" });
    assert.equal(port.supplied("product"), true);
  });

  it("refuses invalid writes without claiming a waiting draft", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { host, port } = await create();
      host.state.draft = 7;
      assert.equal(host.state.draft, undefined);
      assert.equal(port.status("draft").ready, false);
      port.source("product").publish({ value: { name: "Remote" }, status: READY_INPUT }); await tick();
      assert.equal(host.state.draft, "Remote");
    } finally { warn.mockRestore(); }
  });

  it("resolves forward seeds without a computed declaration and diagnoses cycles", async () => {
    const { host } = await create({ product: { name: "Forward" } }, "", forwardCode);
    assert.equal(host.state.draft, "Forward");
    await assert.rejects(create({}, "", cycleCode), /depends on itself|cycle/);
  });

  it("gives early bound edits and accepted same-value null writes ownership", async () => {
    const { dom, root, host, port } = await create();
    const input = root.querySelector("input")!;
    input.value = ""; input.dispatchEvent(new dom.window.Event("input", { bubbles: true })); await tick();
    port.source("product").publish({ value: { name: "Remote" }, status: READY_INPUT }); await tick();
    assert.equal(host.state.draft, "");
    const nullable = await create({}, "", nullableCode);
    nullable.host.state.draft = null;
    nullable.port.source("product").publish({ value: { name: "Remote" }, status: READY_INPUT }); await tick();
    assert.equal(nullable.host.state.draft, null);
    assert.deepEqual(nullable.port.status("draft"), READY_INPUT);
  });

  it("copies a seed before an immediate nested edit", async () => {
    const { host, port } = await create({}, "", objectCode);
    const product = port.source("product");
    product.publish({ value: { name: "Remote" }, status: READY_INPUT });
    (host.state.draft as { name: string }).name = "Edited";
    assert.deepEqual(port.read("product"), { name: "Remote" });
    product.publish({ value: { name: "New" }, status: READY_INPUT }); await tick();
    assert.equal((host.state.draft as { name: string }).name, "Edited");
    product.dispose();
  });

  it("preserves waiting and edited ownership through adoption", async () => {
    for (const edited of [false, true]) {
      const server = await create();
      if (edited) server.host.state.draft = "Kept";
      const html = serializeRenderedForm(server.dom.window.document.body);
      const client = await create({}, html);
      assert.equal(client.host.state.draft, edited ? "Kept" : undefined);
      client.port.source("product").publish({ value: { name: "Remote" }, status: READY_INPUT }); await tick();
      assert.equal(client.host.state.draft, edited ? "Kept" : "Remote");
    }
  });
});
