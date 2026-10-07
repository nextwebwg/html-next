import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { afterEach, describe, it, vi } from "vitest";

import { generateComponent } from "../src/generate.js";
import { parseComponent } from "../src/source-parser.js";
import type { ComponentDefinition } from "../src/template.js";

const source = fileURLToPath(new URL("../src/", import.meta.url));
const fixtures = new URL("./fixtures/direct-extend/", import.meta.url);

interface Runtime {
  readonly factory: (options?: Record<string, unknown>) => Element;
  getComponentHost(element: Element): { state: Record<string, any> } | undefined;
  inspectInstance(element: Element): unknown;
  serializeRenderedForm(container: Element): string;
  registerComponentDefinitions(definitions: readonly ComponentDefinition[]): void;
  lowerDocument(root?: Document): number;
}

/** Loads a compiled component beside the live runtime's inspection, serialization and hydration APIs. */
async function load(definition: ComponentDefinition): Promise<{ runtime: Runtime; document: Document }> {
  const module = generateComponent(definition.controller === undefined ? definition : { ...definition, controller: "./controller.js" })
    .find((artifact) => artifact.path.endsWith(".js"))!.content;
  assert.doesNotMatch(module, /@nextwebwg\/html-next\/runtime/, "the component compiles directly");
  const entry = `${module}
export { getComponentHost, inspectInstance, serializeRenderedForm, registerComponentDefinitions, lowerDocument } from "@nextwebwg/html-next/runtime";`;
  const result = await build({
    stdin: { contents: entry, loader: "js", resolveDir: fileURLToPath(fixtures) },
    bundle: true, format: "esm", write: false, platform: "browser", target: ["es2022"],
    alias: {
      "@nextwebwg/html-next/generated-runtime": `${source}generated-runtime.ts`,
      "@nextwebwg/html-next/runtime": `${source}runtime.ts`,
    },
    plugins: [{ name: "styles", setup(builder) {
      builder.onResolve({ filter: /\.css$/ }, (args) => ({ path: args.path, namespace: "styles" }));
      builder.onLoad({ filter: /.*/, namespace: "styles" }, () => ({ contents: "", loader: "js" }));
    } }],
  });
  const { window } = new JSDOM("<!doctype html><body></body>");
  for (const key of Object.getOwnPropertyNames(window)) {
    if (key in globalThis && !["Event", "CustomEvent", "EventTarget", "document", "Node", "Element"].includes(key)) continue;
    try { vi.stubGlobal(key, (window as unknown as Record<string, unknown>)[key]); } catch { /* read-only global */ }
  }
  vi.stubGlobal("directExtendLog", { hosts: [], events: [] });
  const code = result.outputFiles[0]!.text;
  const loaded = await import(`data:text/javascript;base64,${Buffer.from(`${code}\n// ${Math.random()}`).toString("base64")}`) as Record<string, unknown>;
  const factory = Object.entries(loaded).find(([name]) => name.startsWith("create"))![1] as Runtime["factory"];
  return { runtime: { ...(loaded as unknown as Runtime), factory }, document: window.document };
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("compiled roots in the live runtime's inspection and serialization", async () => {
  const text = await readFile(new URL("parity.html", fixtures), "utf8");
  const definition = parseComponent(text, new URL("parity.html", fixtures).href);
  const rows = [1, 2, 3].map((id) => ({ id, label: `r${id}`, tags: id === 2 ? ["t"] : [] }));

  it("returns the compiled host and inspects its state", async () => {
    const { runtime, document } = await load(definition);
    const element = runtime.factory();
    document.body.append(element);
    await flush();
    const host = runtime.getComponentHost(element)!;
    assert.ok(host, "a compiled root has a host");
    host.state.rows = rows;
    host.state.selected = 2;
    await flush();
    assert.deepEqual(runtime.inspectInstance(element), {
      tag: "x-parity", explicit: [], props: {}, slots: {}, delegates: [],
      state: { ready: true, rows, selected: 2, title: "Rows" },
    });
    assert.equal(runtime.inspectInstance(document.body), undefined);
  });

  it("serializes with row markers and hydrates live to the same DOM and state", async () => {
    const { runtime, document } = await load(definition);
    const element = runtime.factory();
    const container = document.createElement("main");
    container.append(element);
    document.body.append(container);
    await flush();
    const host = runtime.getComponentHost(element)!;
    host.state.rows = rows;
    host.state.selected = 2;
    await flush();
    const rendered = element.outerHTML;
    const html = runtime.serializeRenderedForm(container);
    assert.equal((html.match(/<!--html-next:item-start-->/g) ?? []).length, 3, "each row regains its markers");
    assert.match(html, /data-html-next-instance=/);
    // Serialization leaves the rendered DOM alone.
    assert.equal(element.outerHTML, rendered);

    const server = document.createElement("main");
    server.innerHTML = html;
    document.body.append(server);
    runtime.registerComponentDefinitions([definition]);
    runtime.lowerDocument(document);
    await flush();
    // The live runtime adopts the serialized copy and leaves the compiled root to its own host.
    assert.equal(runtime.getComponentHost(element), host);
    const adopted = server.firstElementChild!;
    assert.notEqual(runtime.getComponentHost(adopted), host);
    const rowsBefore = Array.from(adopted.querySelectorAll("li"));
    assert.deepEqual(runtime.inspectInstance(adopted), {
      ...(runtime.inspectInstance(element) as object), state: { ready: true, rows, selected: 2, title: "Rows" },
    });
    assert.equal(adopted.outerHTML.replaceAll(/<!--html-next:item-(?:start|end)-->/g, ""), rendered);
    // The live instance keeps adopted rows and stays reactive.
    const live = runtime.getComponentHost(adopted)!;
    live.state.selected = 3;
    await flush();
    assert.deepEqual(Array.from(adopted.querySelectorAll("li")), rowsBefore);
    assert.deepEqual(Array.from(adopted.querySelectorAll("li.danger"), (row) => row.getAttribute("data-id")), ["3"]);
  });

  it("leaves generated roots of every kind to their own bundle when the live runtime lowers the document", async () => {
    const button = await readFile(new URL("../benchmarks/fixtures/prop-button.html", import.meta.url), "utf8");
    const propDefinition = parseComponent(button, new URL("../benchmarks/fixtures/prop-button.html", import.meta.url).href);
    const { runtime, document } = await load(propDefinition);
    const element = runtime.factory({ variant: "solid", size: "lg" });
    document.body.append(element);
    await flush();
    const rendered = element.outerHTML;
    runtime.registerComponentDefinitions([propDefinition]);
    runtime.lowerDocument(document);
    await flush();
    assert.equal(element.outerHTML, rendered);
    assert.equal(runtime.getComponentHost(element), undefined);
  });

  it("serializes props and projection, and hydrates live to the same instance", async () => {
    const card = parseComponent(`<template component="x-card" status="early" summary="Card.">
      <defs><prop name="tone" type="keyword" values="info, warn" default="info">Tone.</prop>
        <prop name="count" type="integer" default="1">Count.</prop>
        <state name="open" type="boolean" value="true"></state></defs>
      <article from:data-tone="tone"><header><slot name="head">Untitled</slot></header><p>{count}</p>
        <div $if="open"><slot></slot></div><footer><slot name="foot"><em>{tone}</em></slot></footer></article></template>`, "file:///card.html");
    const { runtime, document } = await load(card);
    const head = document.createElement("h2");
    head.textContent = "Head";
    // Carried projection (what no outlet renders) keeps its slot only through a `slot` attribute, for
    // live instances too: the rendered form records no other name for it.
    const lost = document.createElement("i");
    lost.setAttribute("slot", "gone");
    const element = runtime.factory({ tone: "warn", count: 3, children: ["Body ", document.createElement("hr")], slots: { head: [head], gone: [lost] } });
    const container = document.createElement("main");
    container.append(element);
    document.body.append(container);
    await flush();
    const compiled = runtime.inspectInstance(element) as Record<string, unknown>;
    assert.deepEqual(compiled, {
      tag: "x-card", explicit: ["count", "tone"], props: { tone: "warn", count: 3 }, state: { open: true },
      slots: { "": ["Body ", "<hr>"], gone: ['<i slot="gone"></i>'], head: ["<h2>Head</h2>"] }, delegates: [],
    });
    const html = runtime.serializeRenderedForm(container);
    const server = document.createElement("main");
    server.innerHTML = html;
    document.body.append(server);
    runtime.registerComponentDefinitions([card]);
    runtime.lowerDocument(document);
    await flush();
    const adopted = server.firstElementChild!;
    assert.deepEqual(runtime.inspectInstance(adopted), compiled);
    assert.equal(adopted.outerHTML, element.outerHTML);
  });

  it("keeps a root's consumer attributes, merged with its literals, through live hydration", async () => {
    const card = parseComponent(`<template component="x-plain" status="early" summary="Plain.">
      <defs><state name="n" type="integer" value="1"></state></defs>
      <section class="card own" style="color: red" title="own"><b>{n}</b></section></template>`, "file:///plain.html");
    const { runtime, document } = await load(card);
    const element = runtime.factory({ attributes: { class: "mine", style: "margin: 1px", title: "theirs" } });
    const container = document.createElement("main");
    container.append(element);
    document.body.append(container);
    await flush();
    assert.equal(element.getAttribute("class"), "card own mine");
    const server = document.createElement("main");
    server.innerHTML = runtime.serializeRenderedForm(container);
    document.body.append(server);
    runtime.registerComponentDefinitions([card]);
    runtime.lowerDocument(document);
    await flush();
    assert.equal(server.firstElementChild!.outerHTML, element.outerHTML);
  });

  it("gives an adopted control its bound value unless the user edited it before hydration", async () => {
    const control = parseComponent(`<template component="x-control" status="early" summary="Control.">
      <defs><state name="title" type="string" value="Bound"></state><state name="on" type="boolean" value="true"></state>
      <state name="size" type="string" value="m"></state></defs>
      <section><input .value="title"><input .value="title"><input type="checkbox" bind:checked="on">
      <select bind:value="size"><option value="s">S</option><option value="m">M</option></select></section></template>`, "file:///control.html");
    const { runtime, document } = await load(definition);
    const server = document.createElement("main");
    server.innerHTML = '<section data-component="x-control"><input><input><input type="checkbox"><select><option value="s">S</option><option value="m">M</option></select></section>';
    document.body.append(server);
    const [untouched, edited] = Array.from(server.querySelectorAll("input"));
    edited!.value = "typed";
    runtime.registerComponentDefinitions([control]);
    runtime.lowerDocument(document);
    await flush();
    assert.equal(untouched!.value, "Bound");
    assert.equal(edited!.value, "typed");
    // An untouched checkbox or select takes its binding, and a checkbox's "on" is not written back.
    const checkbox = server.querySelector('input[type="checkbox"]') as HTMLInputElement;
    assert.equal(checkbox.checked, true);
    assert.equal(checkbox.hasAttribute("value"), false);
    assert.equal((server.querySelector("select") as HTMLSelectElement).value, "m");
  });
});
