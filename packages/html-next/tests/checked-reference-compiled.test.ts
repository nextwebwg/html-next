import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { afterEach, describe, it, vi } from "vitest";
import { generateComponent } from "../src/generate.js";
import { componentInputs, READY_INPUT } from "../src/inputs.js";
import { getComponentHost } from "../src/runtime.js";
import { parseComponent } from "../src/source-parser.js";
import { checkedReferenceInitial, checkedReferenceSource } from "./checked-reference-fixture.js";
import { compiledFixtures } from "./hydration-fixtures.js";

const windows: JSDOM[] = [];
let revision = 0;
const tick = async () => { for (let index = 0; index < 12; index += 1) await Promise.resolve(); };
afterEach(() => { for (const dom of windows.splice(0)) dom.window.close(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function create(source: string, props: object = {}) {
  const definition = parseComponent(source, "checked-reference.html");
  const generated = generateComponent(definition).find(file => file.path === `vanilla/${definition.contract.name}.js`)!.content;
  assert.ok(!generated.includes('from "@nextwebwg/html-next/runtime"'), "must use the direct compiler");
  const compiled = await compiledFixtures("esm", "", [definition]);
  const dom = new JSDOM("<!doctype html><body></body>", { url: "https://example.test/" });
  windows.push(dom);
  for (const name of ["document", "Node", "Element", "HTMLElement", "Text", "Comment", "HTMLTemplateElement", "HTMLInputElement", "HTMLTextAreaElement", "HTMLSelectElement", "HTMLOptionElement", "HTMLFormElement", "MutationObserver", "Event", "CustomEvent", "KeyboardEvent", "MouseEvent"]) vi.stubGlobal(name, Reflect.get(dom.window, name));
  const module = await import(`data:text/javascript;base64,${Buffer.from(`${compiled}\n// ${revision++}`).toString("base64")}`) as { factories: Record<string, (props: object) => Element> };
  const root = module.factories[definition.contract.tag]!(props);
  dom.window.document.body.append(root);
  await tick();
  return { root, host: getComponentHost(root)! };
}

describe("compiled actual-reference checks", () => {
  it("checks only executed final reads and retains accepted values until recovery", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { root, host } = await create(checkedReferenceSource);
    const read = () => Object.fromEntries(Object.keys(checkedReferenceInitial).map(id => [id, root.querySelector(`#${id}`)?.textContent]));
    assert.deepEqual(read(), checkedReferenceInitial);
    assert.ok(!warn.mock.calls.some(args => String(args[0]).includes("draft.name")), "unused branches must not warn");
    host.state.choose = true;
    (host.state.draft as Record<string, unknown>).name = "A";
    (host.state.draft as Record<string, unknown>)["odd.key"] = "Quoted";
    (host.state.rows as Record<string, unknown>[])[0]!.name = "Row";
    await tick();
    const accepted = { ...checkedReferenceInitial, "computed-key": "A", "computed-index": "Row", "bad-fallback": "A", "quoted-key": "Quoted", label: "A", "alias-key": "Row", "ordered-name": "true", "ordered-row": "true" };
    assert.deepEqual(read(), accepted);
    (host.state.draft as Record<string, unknown>).name = 17;
    (host.state.rows as Record<string, unknown>[])[0]!.name = 17;
    await tick();
    assert.deepEqual(read(), accepted);
    (host.state.draft as Record<string, unknown>).name = "Recovered";
    await tick();
    assert.equal(root.querySelector("#computed-key")?.textContent, "Recovered");
  });

  it("reads keys and getters once, switches field types and recovers", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { root, host } = await create(`<template component="x-read-once"><defs>
      <state name="record" type="object({ name: string, count: number })" value="{ name: 'Initial', count: 0 }"></state>
      <state name="selector" type="object({ key: string })" value="{ key: 'name' }"></state>
      </defs><output>{$record[$selector.key]}</output></template>`);
    let names = 0, keys = 0;
    host.state.record = { get name() { names += 1; return "Once"; }, count: 2 };
    host.state.selector = { get key() { keys += 1; return "name"; } };
    await tick();
    assert.deepEqual({ names, keys, text: root.textContent }, { names: 1, keys: 1, text: "Once" });
    host.state.selector = { key: "count" }; await tick();
    assert.equal(root.textContent, "2");
    host.state.record = { name: "Another", count: "wrong" }; await tick();
    assert.equal(root.textContent, "2");
    host.state.record = { name: "Another", count: 3 }; await tick();
    assert.equal(root.textContent, "3");
    (host.state.selector as { key: string }).key = "name"; await tick();
    assert.equal(root.textContent, "Another");
  });

  it("resolves optional, open and prototype-named fields without caching input keys", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { root, host } = await create(`<template component="x-field-kinds"><defs>
      <state name="data" type="object({ 'constructor': string, '__proto__': number })" from="{}"></state>
      <state name="choices" type="list" from="[{ value: 3 }]"><prop type="object"><prop name="value" type="number"></prop></prop></state>
      <state name="byName" type="object" open from="{ a: 1 }"><prop name="known" type="number"></prop></state>
      <state name="key" type="string" value="constructor"></state>
      <state name="index" type="string" value="0"></state>
      </defs><section><output id="shape">{$data[$key]}</output><output id="union">{$choices[$index].value}</output><output id="record">{$byName[$key]}</output></section></template>`);
    const read = (id: string) => root.querySelector(`#${id}`)?.textContent;
    assert.equal(read("union"), "3");
    host.state.data = JSON.parse('{"constructor":"Safe","__proto__":5}'); await tick();
    assert.equal(read("shape"), "Safe");
    host.state.key = "__proto__"; await tick();
    assert.equal(read("shape"), "5");
    host.state.data = JSON.parse('{"constructor":12,"__proto__":"wrong"}'); await tick();
    assert.equal(read("shape"), "5");
    host.state.key = "unknown";
    host.state.data = { unknown: 17 };
    host.state.byName = { unknown: 17 };
    host.state.choices = [{ value: false }]; await tick();
    assert.equal(read("shape"), "5");
    assert.equal(read("record"), "17");
    assert.equal(read("union"), "3");
    host.state.choices = [{ value: 4 }]; await tick();
    assert.equal(read("union"), "4");
    host.state.choices = [{ value: null }]; await tick();
    assert.equal(read("union"), "");
  });

  it("uses the current selected prop type and a loop alias’s own type", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { root, host } = await create(`<template component="x-selected-fields"><defs>
      <prop name="mode" type="keyword" values="text, number" default="text">Mode.</prop>
      <prop name="value">Value.<type from="mode">
        <option value="text" type="object({ item: string })"></option>
        <option value="number" type="object({ item: number })"></option>
      </type></prop>
      <state name="rows" type="list(object({ item: string }))" from="[{ item: 7 }]"></state>
      <state name="key" type="string" value="item"></state>
      </defs><section><output id="selected">{$value[$key]}</output><p $each="row of $rows"><output id="alias">{$row[$key]}</output></p></section></template>`);
    const inputs = componentInputs(host);
    const value = inputs.source("value");
    value.publish({ value: { item: "Text" }, status: READY_INPUT });
    await tick();
    assert.equal(root.querySelector("#selected")?.textContent, "Text");
    assert.equal(root.querySelector("#alias")?.textContent, "");
    inputs.source("mode").publish({ value: "number", status: READY_INPUT });
    value.publish({ value: { item: 42 }, status: READY_INPUT });
    (host.state.rows as { item: unknown }[])[0]!.item = "Alias";
    await tick();
    assert.equal(root.querySelector("#selected")?.textContent, "42");
    assert.equal(root.querySelector("#alias")?.textContent, "Alias");
  });
});
