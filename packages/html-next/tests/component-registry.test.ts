import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { afterEach, describe, it, vi } from "vitest";

import { generateComponent } from "../src/generate.js";
import { parseComponent } from "../src/source-parser.js";
import { hotReplacementFiles, hotReplacementResult } from "./hot-replacement.js";

/**
 * componentRegistry (https://nextwebwg.org/declarative-components/javascript#component-registry):
 * each algorithm and error, through the live runtime and a compiled Vanilla module, in jsdom.
 * component-registry-browser.test.ts runs creation and sharing in Chromium, Firefox and WebKit.
 */
const source = fileURLToPath(new URL("../src/", import.meta.url));

const callout = `<template component="ui-callout">
  <props><prop name="tone" type="keyword" values="info, tip, warning" default="info">Tone.</prop></props>
  <aside from:data-tone="$tone"><h2><slot name="heading"></slot></h2><p><slot></slot></p></aside>
</template>`;

type Registry = typeof import("../src/component-registry.js").componentRegistry;

function stubWindow(): Window & typeof globalThis {
  const { window } = new JSDOM("<!doctype html><body><main></main></body>", { url: "https://acme.example/" });
  for (const key of Object.getOwnPropertyNames(window)) {
    if (key in globalThis && !["Event", "CustomEvent", "EventTarget", "document", "Node", "Element", "DocumentFragment", "DOMException"].includes(key)) continue;
    try { vi.stubGlobal(key, (window as unknown as Record<string, unknown>)[key]); } catch { /* read-only global */ }
  }
  return window as unknown as Window & typeof globalThis;
}

/** The live runtime on a fresh observed document, with the live delivery's parser installed. */
async function live() {
  const window = stubWindow();
  const runtime = await import("../src/live.js");
  runtime.observeDocument(window.document);
  return { window, document: window.document, runtime, registry: runtime.componentRegistry };
}

function carrier(document: Document, html: string): HTMLTemplateElement {
  const host = document.createElement("div");
  host.innerHTML = html;
  return host.firstElementChild as HTMLTemplateElement;
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try { await promise; } catch (error) { return error; }
  assert.fail("expected a rejection");
}

function domError(name: string, message?: RegExp) {
  return (error: unknown): boolean => {
    assert.equal((error as DOMException).name, name);
    if (message !== undefined) assert.match((error as DOMException).message, message);
    return true;
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("componentRegistry in the live runtime", () => {
  it("defines from a carrier, gets the definition, and resolves whenDefined with it", async () => {
    const { document, registry } = await live();
    const { define, get, whenDefined } = registry;
    assert.equal(get("ui-callout"), undefined);
    const waiting = whenDefined("ui-callout");
    assert.equal(whenDefined("ui-callout"), waiting, "one promise for each tag, as customElements gives");
    define(carrier(document, callout));
    const definition = get("ui-callout");
    assert.deepEqual(definition, { tag: "ui-callout" });
    assert.equal(await waiting, definition);
    assert.equal(await whenDefined("ui-callout"), definition);
  });

  it("lowers the invocations already in the document when it defines", async () => {
    const { document, registry } = await live();
    document.querySelector("main")!.innerHTML = '<ui-callout tone="tip">Authored</ui-callout>';
    registry.define(carrier(document, callout));
    const root = document.querySelector("main")!.firstElementChild!;
    assert.equal(root.localName, "aside");
    assert.equal(root.getAttribute("data-tone"), "tip");
  });

  it("throws define's errors: TypeError, SyntaxError, and NotSupportedError for a custom element", async () => {
    const { document, window, registry } = await live();
    assert.throws(() => registry.define(document.createElement("div") as unknown as HTMLTemplateElement), TypeError);
    assert.throws(() => registry.define(document.createElement("template")), TypeError);
    assert.throws(() => registry.define(carrier(document, '<template component="nohyphen"><p></p></template>')),
      domError("SyntaxError", /^HC005: /));
    window.customElements.define("x-custom", class extends window.HTMLElement {});
    assert.throws(() => registry.define(carrier(document, '<template component="x-custom"><p></p></template>')), domError("NotSupportedError"));
    const first = carrier(document, callout);
    registry.define(first);
    registry.define(first);
  });

  it("replaces a registered definition: each connected instance re-renders with its state, props, attributes and slotted children", async () => {
    const { document, registry, runtime } = await live();
    const counter = (tag: string) => `<template component="${tag}"><defs><state name="n" type="number" value="0"></state>
      <handler name="add"><set name="n" expr:value="$n + 1"></set></handler></defs><button on:click="add">{$n}</button></template>`;
    const panel = (root: string, extra = "") => `<template component="ui-panel"><defs>
      <prop name="title" type="string" default="Untitled">Title.</prop>
      <state name="count" type="number" value="0"></state>${extra}</defs>${root}</template>`;
    registry.define(carrier(document, counter("x-count")));
    registry.define(carrier(document, panel(`<section class="panel" title="Old"><h2>{$title}</h2><x-count></x-count><slot></slot></section>`,
      '<state name="open" type="boolean" value="false"></state>')));
    const main = document.querySelector("main")!;
    main.innerHTML = '<ui-panel id="p" class="mine" title="Hello"><x-count id="slotted"></x-count></ui-panel>';
    await settle();
    const before = main.firstElementChild!;
    const slotted = document.getElementById("slotted")!;
    slotted.click();
    slotted.click();
    for (let index = 0; index < 4; index += 1) (before.querySelector("button:not(#slotted)") as HTMLElement).click();
    runtime.getComponentHost(before)!.state.count = 5;
    await settle();
    assert.equal(slotted.textContent, "2");
    registry.define(carrier(document, panel(`<article class="panel2"><h3>{$title}: {$count} {$label}</h3><x-count></x-count><x-count class="extra"></x-count><slot></slot></article>`,
      '<state name="label" type="string" value="new"></state>')));
    await settle();
    const after = main.firstElementChild!;
    assert.equal(after.localName, "article", "the new definition's root");
    assert.equal(after.id, "p", "the invocation's attributes carry over");
    assert.equal(after.getAttribute("class"), "panel2 mine", "the old template's class token goes, the invocation's stays");
    assert.equal(after.hasAttribute("title"), false, "the old template's literal goes");
    assert.equal(after.querySelector("h3")!.textContent, "Hello: 5 new", "props, kept state, and a new state's default");
    assert.equal(document.getElementById("slotted"), slotted, "the slotted instance is the same element");
    assert.equal(slotted.textContent, "2", "and keeps its state");
    const nested = after.querySelector("button:not(#slotted):not(.extra)") as HTMLElement;
    assert.equal(nested.textContent, "4", "the new template's first <x-count> keeps the old one's state");
    assert.equal(after.querySelector(".extra")!.textContent, "0", "one with no counterpart starts from its declared state");
    nested.click();
    slotted.click();
    await settle();
    assert.deepEqual([nested.textContent, slotted.textContent], ["5", "3"], "both connected");
    assert.equal(runtime.getComponentHost(after)!.state.open, undefined, "a removed state is gone");
    registry.define(carrier(document, panel(`<article class="panel2"><h3>{$title}: {$count} {$label}</h3><x-count></x-count><x-count class="extra"></x-count><slot></slot></article>`,
      '<state name="label" type="string" value="new"></state>')));
    assert.equal(main.firstElementChild, after, "the same definition again changes nothing");
  });

  it("keeps the state of the component instances a replaced template renders, at every depth", async () => {
    const { document, registry, runtime } = await live();
    registry.define(carrier(document, `<template component="x-count"><defs><state name="n" type="number" value="0"></state></defs><b>{$n}</b></template>`));
    registry.define(carrier(document, `<template component="ui-mid"><defs><state name="open" type="boolean" value="false"></state></defs><div><x-count></x-count></div></template>`));
    const outer = (root: string) => `<template component="ui-outer"><defs><state name="label" type="string" value="one"></state></defs>${root}</template>`;
    registry.define(carrier(document, outer("<section><ui-mid></ui-mid></section>")));
    const main = document.querySelector("main")!;
    main.innerHTML = "<ui-outer></ui-outer>";
    await settle();
    runtime.getComponentHost(main.querySelector("[component~=ui-mid]")!)!.state.open = true;
    runtime.getComponentHost(main.querySelector("b")!)!.state.n = 7;
    await settle();
    registry.define(carrier(document, outer("<article><h1>Outer</h1><ui-mid></ui-mid></article>")));
    await settle();
    assert.equal(main.firstElementChild!.localName, "article");
    assert.deepEqual([runtime.getComponentHost(main.querySelector("[component~=ui-mid]")!)!.state.open, main.querySelector("b")!.textContent], [true, "7"]);
  });

  it("keeps a parent's bindings on an instance its definition replaced", async () => {
    const { document, registry, runtime } = await live();
    const inner = (root: string) => `<template component="ui-inner"><defs><prop name="text" type="string" default="">Text.</prop></defs>${root}</template>`;
    registry.define(carrier(document, inner("<b>{$text}</b>")));
    registry.define(carrier(document, `<template component="ui-outer"><defs><state name="label" type="string" value="one"></state></defs>
      <div><ui-inner from:text="$label"></ui-inner></div></template>`));
    const main = document.querySelector("main")!;
    main.innerHTML = "<ui-outer></ui-outer>";
    await settle();
    registry.define(carrier(document, inner("<i>{$text}</i>")));
    await settle();
    assert.equal(main.querySelector("i")!.textContent, "one", "the bound value, on the new root");
    runtime.getComponentHost(main.firstElementChild!)!.state.label = "two";
    await settle();
    assert.equal(main.querySelector("i")!.textContent, "two", "the binding still reaches it");
  });

  it("rejects whenDefined for a name that is not a valid custom element name", async () => {
    const { registry } = await live();
    domError("SyntaxError")(await rejection(registry.whenDefined("nohyphen")));
    domError("SyntaxError")(await rejection(registry.whenDefined("X-Upper")));
  });

  it("creates the native root, not yet connected, with its props and slotted content", async () => {
    const { document, registry } = await live();
    const { define, create } = registry;
    define(carrier(document, callout));
    const heading = document.createElement("span");
    heading.slot = "heading";
    heading.textContent = "Before you start";
    const root = create("ui-callout", { props: { tone: "tip" }, content: [heading, "Install first."] });
    assert.equal(root.localName, "aside");
    assert.equal(root.isConnected, false);
    assert.equal(root.getAttribute("data-tone"), "tip");
    assert.equal(root.querySelector("h2")!.textContent, "Before you start");
    assert.equal(root.querySelector("h2 > span"), heading, "the given node, in its slot");
    assert.equal(root.querySelector("p")!.textContent, "Install first.");
    document.querySelector("main")!.append(root);
    await settle();
    assert.equal(root.isConnected, true);
    // A fragment's children are the content.
    const fragment = document.createDocumentFragment();
    fragment.append("From a fragment");
    assert.equal(create("ui-callout", { content: fragment }).querySelector("p")!.textContent, "From a fragment");
    assert.equal(create("ui-callout").getAttribute("data-tone"), "info");
  });

  it("throws create's errors: NotSupportedError, NotFoundError and TypeError", async () => {
    const { document, window, registry } = await live();
    window.customElements.define("x-custom", class extends window.HTMLElement {});
    assert.throws(() => registry.create("x-custom"), domError("NotSupportedError"));
    assert.throws(() => registry.create("ui-missing"), domError("NotFoundError"));
    registry.define(carrier(document, callout));
    assert.throws(() => registry.create("ui-callout", { props: { color: "red" } }), TypeError);
  });

  it("updates an instance's props in the next flush, created or lowered, and throws for anything else", async () => {
    const { document, registry } = await live();
    const { define, create, update } = registry;
    define(carrier(document, callout));
    const root = create("ui-callout", { props: { tone: "tip" } });
    document.querySelector("main")!.append(root);
    await settle();
    update(root, { tone: "warning" });
    await settle();
    assert.equal(root.getAttribute("data-tone"), "warning");
    update(root, { tone: undefined });
    await settle();
    assert.equal(root.getAttribute("data-tone"), "info", "undefined returns the prop to its default");
    assert.throws(() => update(root, { color: "red" }), TypeError);
    assert.throws(() => update(document.body, { tone: "tip" }), TypeError);
  });

  it("upgrades the invocations inside a root synchronously and leaves unregistered tags alone", async () => {
    const { document, registry } = await live();
    registry.define(carrier(document, callout));
    const container = document.createElement("div");
    container.innerHTML = '<ui-callout tone="warning">Now</ui-callout><ui-unknown></ui-unknown>';
    registry.upgrade(container);
    assert.equal(container.firstElementChild!.localName, "aside");
    assert.equal(container.firstElementChild!.getAttribute("data-tone"), "warning");
    assert.equal(container.lastElementChild!.localName, "ui-unknown");
    registry.upgrade(container);
    assert.equal(container.children.length, 2, "an upgraded instance is not lowered again");
  });
});

/** A compiled Vanilla module and its own bundle of the generated runtime, evaluated in the stubbed window. */
async function compiledBundle(text: string, extra = ""): Promise<Record<string, unknown>> {
  const module = generateComponent(parseComponent(text, "https://acme.example/c.html")).find((artifact) => artifact.path.endsWith(".js"))!.content;
  const result = await build({
    stdin: { contents: `${module}\nexport { componentRegistry } from "@nextwebwg/html-next/generated-runtime";\n${extra}`, loader: "js", resolveDir: source },
    bundle: true, format: "esm", write: false, platform: "browser", target: ["es2022"],
    alias: { "@nextwebwg/html-next/generated-runtime": `${source}generated-runtime.ts`, "@nextwebwg/html-next/runtime": `${source}runtime.ts` },
    plugins: [{ name: "styles", setup(builder) {
      builder.onResolve({ filter: /\.css$/ }, (args) => ({ path: args.path, namespace: "styles" }));
      builder.onLoad({ filter: /.*/, namespace: "styles" }, () => ({ contents: "", loader: "js" }));
    } }],
  });
  return import(`data:text/javascript;base64,${Buffer.from(`${result.outputFiles[0]!.text}\n// ${Math.random()}`).toString("base64")}`) as Promise<Record<string, unknown>>;
}

describe("componentRegistry with compiled Vanilla modules", () => {
  it("defines a compiled component when its module is evaluated, and creates and updates it", async () => {
    const window = stubWindow();
    const compiled = await compiledBundle(callout);
    const registry = compiled.componentRegistry as Registry;
    assert.deepEqual(registry.get("ui-callout"), { tag: "ui-callout" });
    const heading = window.document.createElement("span");
    heading.setAttribute("slot", "heading");
    heading.textContent = "Heading";
    const root = registry.create("ui-callout", { props: { tone: "tip" }, content: [heading, "Body"] });
    assert.equal(root.localName, "aside");
    assert.equal(root.isConnected, false);
    assert.equal(root.getAttribute("data-tone"), "tip");
    assert.equal(root.querySelector("h2 > span"), heading);
    assert.equal(root.querySelector("p")!.textContent, "Body");
    window.document.body.append(root);
    await settle();
    registry.update(root, { tone: "warning" });
    await settle();
    assert.equal(root.getAttribute("data-tone"), "warning");
    assert.throws(() => registry.create("ui-callout", { props: { color: "red" } }), TypeError);
    assert.throws(() => registry.update(root, { color: "red" }), TypeError);
    // Without the live runtime there is no parser to read a carrier.
    assert.throws(() => registry.define(window.document.createElement("template")), TypeError);
    const template = window.document.createElement("template");
    template.setAttribute("component", "ui-other");
    assert.throws(() => registry.define(template), domError("NotSupportedError"));
  });

  it("replaces a compiled definition when a changed module is evaluated: its instances re-render with their state, props, attributes, slotted children and parent bindings", async () => {
    stubWindow();
    const directory = await mkdtemp(join(tmpdir(), "html-next-hot-"));
    try {
      for (const [path, text] of Object.entries(await hotReplacementFiles())) await writeFile(join(directory, path), text);
      const url = (path: string) => pathToFileURL(join(directory, path)).href;
      await import(url("first.js"));
      const { run } = await import(url("scenario.js")) as { run: (replace: () => Promise<unknown>) => Promise<unknown> };
      assert.deepEqual(await run(() => import(url("second.js"))), hotReplacementResult);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("shares one registry between bundles: another bundle creates and updates what a compiled module defined", async () => {
    const window = stubWindow();
    const compiled = await compiledBundle(callout);
    const other = await compiledBundle(callout.replaceAll("ui-callout", "ui-badge"));
    const registry = other.componentRegistry as Registry;
    assert.notEqual(compiled.componentRegistry, registry, "separate bundles");
    const waiting = (compiled.componentRegistry as Registry).whenDefined("ui-badge");
    assert.deepEqual(await waiting, { tag: "ui-badge" });
    const root = registry.create("ui-callout", { props: { tone: "tip" } });
    window.document.body.append(root);
    await settle();
    registry.update(root, { tone: "warning" });
    await settle();
    assert.equal(root.getAttribute("data-tone"), "warning");
    // The live runtime, a third bundle, finds both.
    const runtime = await import("../src/runtime.js");
    assert.deepEqual(runtime.componentRegistry.get("ui-badge"), { tag: "ui-badge" });
    runtime.componentRegistry.update(root, { tone: "info" });
    await settle();
    assert.equal(root.getAttribute("data-tone"), "info");
  });
});

describe("componentRegistry on a server", () => {
  it("imports without a document", async () => {
    assert.equal(typeof (globalThis as { document?: unknown }).document, "undefined");
    const index = await import("../src/index.js");
    const runtime = await import("../src/runtime.js");
    const generated = await import("../src/generated-runtime.js");
    for (const module of [index, runtime, generated]) assert.ok(module.componentRegistry instanceof module.ComponentRegistry);
  });
});
