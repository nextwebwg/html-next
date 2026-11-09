import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, it } from "vitest";

import { compileScript, compileTemplate, parse as parseVue } from "@vue/compiler-sfc";
import { build, type BuildOptions } from "esbuild";
import { chromium, firefox, webkit, type BrowserType, type Page } from "playwright";

import { convertComponents } from "../src/index.js";
import { launchParityBrowser } from "../../html-next/tests/pixel-parity.js";
import { dynamicPlainSource, plainSlotExpected, plainSlotFiles, plainSlotInvocations, repeatedPlainSource } from "../../html-next/tests/fixtures/plain-slot-ownership.js";

/**
 * Columns as markup (https://nextwebwg.org/declarative-components/components#columns-as-markup) in
 * converted Vue: the spec's data table, a consumer `$if` column, a keyed `$each` column list whose
 * cells follow a reorder, context read from cell content, `$columns.length` before the header row,
 * plain slot content placed once, and the warnings for content an accepting slot leaves out. Vue
 * renders in the browser and on the server, then hydrates; each matches the live runtime.
 */
const enabled = process.env.HTMLNEXT_TARGET_TEST === "1";
const nodeModules = new URL("../node_modules", import.meta.url).pathname;
// The server renderer is a dependency of the html-next package's own tests.
const serverModules = new URL("../../html-next/node_modules", import.meta.url).pathname;
const livePath = new URL("../../html-next/src/live.ts", import.meta.url).pathname;
const wrappedMovingPlain = dynamicPlainSource.replace("<x-moving-column>", '<template $with="1 as ignored"><x-moving-column>')
  .replace("</x-moving-column></x-moving-list>", "</x-moving-column></template></x-moving-list>");

const conditionalSlots = [
  ["direct", '<slot $if="$open"></slot>', "true"],
  ["ancestor", '<div $if="$open"><slot></slot></div>', "true"],
  ["match", '<template $match><p $when="$open"><slot></slot></p><i $else>Closed</i></template>', "true"],
  ["closed", '<slot $if="$open"></slot>', "false"],
  ["lazy", '<slot $if="$open"></slot>', "true"],
].map(([name, outlet, initial]) => `<template component="x-single-${name}"><defs>
<state name="open" type="boolean" value="${initial}"></state><handler name="toggle"><set name="open" expr:value="not $open"></set></handler>
</defs><section data-single-slot="${name}"><button on:click="toggle">Toggle</button>${outlet}<footer>Tail</footer></section></template>`).join("") +
`<template component="x-single-page"><article>${["direct", "ancestor", "match", "closed", "lazy"].map(name =>
  `<x-single-${name}>${name === "lazy" ? '<template slot=""><input value="Initial"></template>' : '<input value="Initial">'}</x-single-${name}>`).join("")}</article></template>`;

const receivingSlots = `<template component="x-receiving-item"><defs><prop name="label" type="string">Label.</prop>
<state name="count" type="number" value="0"></state><slot name="detail"></slot><context name="tone" from="x-receiving-list"></context>
<handler name="add"><set name="count" expr:value="$count + 1"></set></handler></defs>
<span data-receiving-item><input value="Initial"><button on:click="add">{$label}:{$count}:{$tone}</button><slot name="detail"></slot></span></template>
<template component="x-receiving-list"><defs><slot accepts="x-receiving-item" as="items"></slot>
<state name="first" type="boolean" value="true"></state><state name="second" type="boolean" value="true"></state><state name="tone" type="string" value="Tone"></state>
<handler name="toggle-first"><set name="first" expr:value="not $first"></set></handler><handler name="toggle-second"><set name="second" expr:value="not $second"></set></handler></defs>
<section data-receiving-list><output>{$items.length}</output><button data-receiving-action="first" on:click="toggle-first">First</button><button data-receiving-action="second" on:click="toggle-second">Second</button>
<p $if="$first"><slot>FirstFallback</slot></p><div $if="$second"><slot>SecondFallback</slot></div><aside data-receiving-borrowed><b $each="item of $items"><slot of="$item" name="detail">BorrowedFallback</slot></b></aside><footer>Tail</footer></section></template>
<template component="x-receiving-detail"><defs><context name="count" from="x-receiving-item"></context></defs><strong data-receiving-detail>{$count}</strong></template>
<template component="x-receiving-page"><defs><state name="label" type="string" value="Before"></state><handler name="update"><set name="label" expr:value="'After'"></set></handler></defs>
<aside><button data-receiving-update on:click="update">Update</button><x-receiving-list><x-receiving-item from:label="$label"><x-receiving-detail slot="detail"></x-receiving-detail></x-receiving-item></x-receiving-list></aside></template>`;

const source = `<template component="x-column" status="early" summary="Column."><th $attributes scope="col"><slot name="header">{$header}</slot></th>
  <defs><prop name="field" type="string">Field.</prop><prop name="header" type="string">Header.</prop>
    <prop name="span" type="number" default="1">Span.</prop>
    <state name="tone" type="string" value="quiet"></state>
    <slot name="header"></slot><slot name="note"></slot><slot name="cell"><prop name="row" type="object" required>Row.</prop></slot>
    <slot name="tag"><prop name="size" type="number">Size.</prop><prop name="unit" type="string" default="px">Unit.</prop><prop name="label" type="string" required>Label.</prop></slot></defs></template>
<template component="x-datatable" status="early" summary="Table." controller="./table.js"><defs>
    <prop name="rows" type="list(object({ id: number, name: string, price: number }))" required>Rows.</prop>
    <prop name="lead" type="boolean" default="true">Lead.</prop>
    <state name="density" type="string" value="compact"></state>
    <slot accepts="x-column" as="columns"></slot></defs>
  <table><caption>{$columns.length} columns</caption><thead><tr><template $slot></template></tr></thead>
    <tbody><tr $each="row of $rows" $key="$row.id"><td $each="column of $columns" $key="$column">
      <slot of="$column" name="cell" from:row="$row">{$row[$column.field]}</slot></td></tr></tbody>
    <tfoot><tr><td $each="column of $columns" $key="$column"><template $if="$lead"><slot of="$column" name="note">-</slot></template><slot of="$column" name="note"></slot><slot of="$column" name="tag" size="3" extra="x"></slot></td></tr></tfoot></table></template>
<template component="x-badge" status="early" summary="Badge."><defs><prop name="text" type="string">Text.</prop>
    <context name="tone" from="x-column"></context><context name="density" from="x-datatable"></context></defs>
  <b>{$text}:{$tone}:{$density}</b></template>
<template component="x-column-preset" status="early" summary="Preset."><x-column field="name"></x-column></template>
<template component="x-note" status="early" summary="Note."><th><slot name="label"></slot></th><defs><slot name="label"></slot><slot name="detail"></slot></defs></template>
<template component="x-notes" status="early" summary="Notes."><defs><slot accepts="x-note" as="notes"></slot></defs>
  <table><thead><tr><template $slot></template></tr></thead>
    <tbody><tr><td $each="note of $notes" $key="$note"><slot of="$note" name="detail">none</slot></td></tr></tbody></table></template>
<template component="x-app" status="early" summary="App."><defs>
    <state name="products" type="list(object({ id: number, name: string, price: number }))"
      value="[{ id: 1, name: 'Desk lamp', price: 49 }, { id: 2, name: 'Notebook', price: 6.5 }]"></state>
    <state name="showId" type="boolean" value="false"></state>
    <state name="first" type="boolean" value="false"></state>
    <state name="extra" type="list(object({ key: string, label: string }))" value="[{ key: 'name', label: 'N' }, { key: 'price', label: 'P' }]"></state>
    <handler name="toggle"><set name="showId" expr:value="not $showId"></set></handler>
    <handler name="swap"><set name="extra" expr:value="[{ key: 'price', label: 'P' }, { key: 'name', label: 'N' }]"></set></handler>
    <handler name="add"><set name="products" expr:value="[{ id: 1, name: 'Desk lamp', price: 49 }, { id: 2, name: 'Notebook', price: 6.5 }, { id: 3, name: 'Pen', price: 2 }]"></set></handler>
    <state name="warned" type="boolean" value="false"></state>
    <handler name="note"><set name="first" expr:value="true"></set></handler>
    <handler name="warn"><set name="warned" expr:value="true"></set></handler>
    <state name="lead" type="boolean" value="true"></state>
    <handler name="unlead"><set name="lead" expr:value="false"></set></handler></defs>
  <main><button type="button" class="toggle" on:click="toggle">Id</button><button type="button" class="swap" on:click="swap">Swap</button>
    <button type="button" class="add" on:click="add">Add</button><button type="button" class="note" on:click="note">Note</button>
    <button type="button" class="warn" on:click="warn">Warn</button><button type="button" class="unlead" on:click="unlead">Unlead</button>
    <x-datatable from:rows="$products" from:lead="$lead">
      <x-column $if="$showId" field="id" header="Id"></x-column>
      <x-column field="name" header="Name" span="wide"><i slot="note">kept</i></x-column>
      <x-column class="numeric" span="2">
        <abbr slot="header" title="Price in US dollars">Price</abbr>
        <template slot="cell"><x-badge from:text="$row.name"></x-badge>{$row.price}</template>
      </x-column>
      <x-column $each="column of $extra" $key="$column.key" from:field="$column.key" from:header="$column.label"></x-column>
    </x-datatable>
    <x-notes><x-note $if="$first"><i slot="label">First</i></x-note><x-note><i slot="label">Kept</i><b slot="detail">kept</b></x-note><x-note></x-note></x-notes>
    <x-datatable $if="$warned" from:rows="[{ id: 1, name: 'A', price: 1 }]"><x-column field="name"></x-column>stray<x-column-preset></x-column-preset>
      <x-column><span slot="cell">plain</span></x-column></x-datatable><x-more></x-more></main></template>
<template component="x-more" status="early" summary="More."><defs>
    <state name="wide" type="boolean" value="false"></state>
    <state name="tags" type="list(string)" value="['p', 'q']"></state>
    <handler name="widen"><set name="wide" expr:value="not $wide"></set></handler>
    <handler name="retag"><set name="tags" expr:value="['q', 'r']"></set></handler></defs>
  <div><button type="button" class="widen" on:click="widen">Widen</button><button type="button" class="retag" on:click="retag">Retag</button>
    <x-datatable from:rows="[{ id: 1, name: 'A', price: 1 }]">
      <template $match><x-column $when="$wide" field="price" header="Wide"></x-column><x-column $else field="name" header="Narrow"><template slot="note"><u>n</u></template></x-column></template>
      <template $with="'W' as label"><x-column from:header="$label"><template slot="cell"><x-badge from:text="$label"></x-badge></template></x-column></template>
      <template $each="tag of $tags" $key="$tag"><x-column from:header="$tag"><template slot="cell"><x-badge from:text="$tag"></x-badge></template><template slot="tag"><em>{$size + 1}{$unit}</em></template></x-column></template>
    </x-datatable></div></template>${Object.values(plainSlotFiles).join("")}${wrappedMovingPlain}${repeatedPlainSource}${conditionalSlots}${receivingSlots}
<template component="x-plain-page"><main>${plainSlotInvocations}<x-moving-page></x-moving-page><x-repeat-page></x-repeat-page></main></template>
<template component="x-hand-card"><defs><state name="first" type="boolean" value="true"></state><handler name="toggle"><set name="first" expr:value="not $first"></set></handler></defs>
<section data-hand-card><button data-hand-toggle on:click="toggle">Toggle</button><p $if="$first"><slot name="cell">First</slot></p><b><slot name="cell">Second</slot></b></section></template>`;
/** Reads the table's \`as\` list from its controller. */
const controller = `export default function initialize(host) {
  return host.effect(() => host.root.setAttribute("data-columns", host.state.columns.map((column) => (column.header ?? column.field ?? "-") + ":" + column.span).join(",")));
}`;

/** Each table without marks, comments or runtime attributes, and its first body row's cells, marked to follow their identity. */
const READ = `Array.from(document.querySelectorAll("table"), (table) => {
  const read = (node) => {
    if (node.nodeType === 3) return node.data.trim();
    if (node.nodeType !== 1 || node.localName === "template") return "";
    const keep = ["class", "scope", "title", "slot"].filter((name) => node.hasAttribute(name)).map((name) => " " + name + '="' + node.getAttribute(name) + '"');
    return "<" + node.localName + keep.join("") + ">" + Array.from(node.childNodes, read).join("") + "</" + node.localName + ">";
  };
  return read(table) + " columns: " + table.closest("[data-columns]")?.getAttribute("data-columns");
})`;
const mark = `Array.from(document.querySelectorAll("table")[0].querySelectorAll("tbody tr:first-child td"), (cell, index) => { cell.dataset.was = String(index); }).length`;
const marks = `Array.from(document.querySelectorAll("table")[0].querySelectorAll("tbody tr:first-child td"), (cell) => cell.dataset.was ?? null)`;

/** Live's tables run the controller as its loader would: once each, given the table's host. */
const LIVE_CONTROLLERS = `(() => { const initialize = ${controller.replace("export default ", "")};
  window.started ??= new WeakSet();
  for (const table of document.querySelectorAll("table")) {
    const host = window.HtmlRuntime.getComponentHost(table, "x-datatable");
    if (host !== undefined && !window.started.has(table)) { window.started.add(table); initialize(host); }
  } })()`;

async function tables(page: Page, expected?: readonly string[]): Promise<string[]> {
  if (expected !== undefined) {
    await page.waitForFunction(`JSON.stringify(${READ}) === ${JSON.stringify(JSON.stringify(expected))}`, undefined, { timeout: 5_000 }).catch(() => {});
  }
  return page.evaluate(READ) as Promise<string[]>;
}

const sfc = { name: "compiled-vue-sfc", setup(pluginBuild: { onResolve: (options: { filter: RegExp }, callback: (args: { path: string; resolveDir: string }) => { path: string }) => void }) {
  pluginBuild.onResolve({ filter: /\.vue$/ }, (args) => ({ path: resolve(args.resolveDir, args.path.replace(/\.vue$/, ".ts")) }));
} };
const ssrSfc = { name: "compiled-vue-sfc-ssr", setup(pluginBuild: { onResolve: (options: { filter: RegExp }, callback: (args: { path: string; resolveDir: string }) => { path: string }) => void }) {
  pluginBuild.onResolve({ filter: /\.vue$/ }, (args) => ({ path: resolve(args.resolveDir, args.path.replace(/\.vue$/, ".ssr.ts")) }));
} };

describe.skipIf(!enabled)("columns as markup in converted Vue", () => {
  let directory = "";
  let live = "";
  let fresh = "";
  let hydrate = "";
  let server = "";
  let plainServer = "";
  let plainHydrate = "";
  let plainFresh = "";

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-vue-columns-"));
    await symlink(nodeModules, join(directory, "node_modules"), "dir");
    const app = join(directory, "app");
    await mkdir(app);
    await writeFile(join(app, "columns.html"), source);
    await writeFile(join(app, "table.js"), controller);
    live = join(directory, "live.js");
    await build({ entryPoints: [livePath], outfile: live, bundle: true, format: "iife", globalName: "HtmlRuntime", platform: "browser", target: ["es2022"] });

    const out = join(app, "vue");
    const manifest = await convertComponents({ mode: "application", target: "vue", root: app, outDirectory: out, entries: ["columns.html"] });
    const files = manifest.components.map((component) => component.artifact);
    // vue-tsc checks the generated components as an application's build does.
    await writeFile(join(out, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler",
      strict: true, skipLibCheck: true, noEmit: true, allowImportingTsExtensions: true, lib: ["ES2022", "DOM", "DOM.Iterable"] }, files }));
    const { execFile } = await import("node:child_process");
    await new Promise<void>((done, fail) => execFile(join(nodeModules, ".bin/vue-tsc"), ["-p", join(out, "tsconfig.json")], { cwd: out },
      (error, stdout) => error === null ? done() : fail(new Error(stdout || String(error)))));
    for (const component of manifest.components) {
      const file = join(out, component.artifact);
      const parsed = parseVue(await readFile(file, "utf8"), { filename: file });
      assert.deepEqual(parsed.errors, [], component.artifact);
      await writeFile(file.replace(/\.vue$/, ".ts"), compileScript(parsed.descriptor, { id: component.tag, inlineTemplate: true }).content);
      const script = compileScript(parsed.descriptor, { id: component.tag });
      const template = compileTemplate({ source: parsed.descriptor.template!.content, filename: file, id: component.tag, ssr: true, ssrCssVars: [],
        compilerOptions: { bindingMetadata: script.bindings ?? {} } });
      assert.deepEqual(template.errors, []);
      await writeFile(file.replace(/\.vue$/, ".ssr.ts"), `${script.content.replace("export default", "const Component =")}\n${template.code}\nexport default Object.assign(Component, { ssrRender });\n`);
    }
    const artifact = manifest.components.find((component) => component.tag === "x-app")!.artifact;
    const plain = manifest.components.find(component => component.tag === "x-plain-page")!.artifact;
    const hand = manifest.components.find(component => component.tag === "x-hand-card")!.artifact;
    const single = manifest.components.find(component => component.tag === "x-single-page")!.artifact;
    const receiving = manifest.components.find(component => component.tag === "x-receiving-page")!.artifact;
    const plainConsumer = `const Counter = defineComponent({ setup() {
      const count = ref(0), id = useId(), context = inject("plain-context");
      onUnmounted(() => { if (typeof window !== "undefined") window.plainCounterDisposals = (window.plainCounterDisposals ?? 0) + 1; });
      return () => h("button", { id, "data-hand-counter": "", onClick: () => { count.value++; } }, context + ":" + count.value);
    } });
    const PlainConsumer = defineComponent({ setup() {
      provide("plain-context", "Context");
      const label = ref("A"); if (typeof window !== "undefined") window.updatePlainLabel = () => { label.value = "B"; };
      return () => { const value = label.value; return h(Fragment, [h(Plain), h(Single), h(Receiving), h("aside", { "data-hand-live": "" }, h(Hand, {}, { cell: () => [h("mark", value), h("input", { value, onInput: event => { label.value = event.target.value; } }), h(Counter)] })),
        h("aside", { "data-hand-empty": "" }, h(Hand, {}, { cell: () => createTextVNode("") }))]); };
    } });`;
    const options: BuildOptions = { bundle: true, format: "iife", platform: "browser", target: ["es2022"], nodePaths: [nodeModules], plugins: [sfc] };
    await writeFile(join(out, "entry.ts"), `import { createApp, h } from "vue"; import App from "./${artifact}"; createApp({ render: () => h(App) }).mount("#mount");`);
    await build({ ...options, entryPoints: [join(out, "entry.ts")], outfile: fresh = join(directory, "vue.js") });
    await writeFile(join(out, "hydrate.ts"), `import { createSSRApp, h } from "vue"; import App from "./${artifact}"; createSSRApp({ render: () => h(App) }).mount("#mount");`);
    await build({ ...options, entryPoints: [join(out, "hydrate.ts")], outfile: hydrate = join(directory, "hydrate.js") });
    await writeFile(join(out, "plain-hydrate.ts"), `import { createSSRApp, createTextVNode, defineComponent, Fragment, h, inject, onUnmounted, provide, ref, useId } from "vue"; import Plain from "./${plain}"; import Hand from "./${hand}"; import Single from "./${single}"; import Receiving from "./${receiving}";
${plainConsumer}
const app = createSSRApp(PlainConsumer); app.mount("#mount"); window.finishPlain = () => app.unmount();`);
    await build({ ...options, entryPoints: [join(out, "plain-hydrate.ts")], outfile: plainHydrate = join(directory, "plain-hydrate.js") });
    await writeFile(join(out, "plain-fresh.ts"), (await readFile(join(out, "plain-hydrate.ts"), "utf8")).replaceAll("createSSRApp", "createApp"));
    await build({ ...options, entryPoints: [join(out, "plain-fresh.ts")], outfile: plainFresh = join(directory, "plain-fresh.js") });
    await writeFile(join(out, "server.ts"), `import { createSSRApp, createTextVNode, defineComponent, Fragment, h, inject, onUnmounted, provide, ref, useId } from "vue"; import { renderToString } from "@vue/server-renderer"; import App from "./${artifact}";
import Plain from "./${plain}"; import Hand from "./${hand}"; import Single from "./${single}"; import Receiving from "./${receiving}";
${plainConsumer}
export const render = () => renderToString(createSSRApp({ render: () => h(App) }));
export const renderPlain = () => renderToString(createSSRApp(PlainConsumer));`);
    const serverBuild = await build({ entryPoints: [join(out, "server.ts")], bundle: true, format: "esm", platform: "node", write: false, nodePaths: [serverModules, nodeModules], plugins: [ssrSfc] });
    const serverModule = join(directory, "server.mjs");
    await writeFile(serverModule, serverBuild.outputFiles[0]!.text);
    const module = await import(pathToFileURL(serverModule).href) as { render(): Promise<string>; renderPlain(): Promise<string> };
    server = await module.render();
    plainServer = await module.renderPlain();
  }, 180_000);
  afterAll(async () => { if (directory !== "") await rm(directory, { recursive: true, force: true }); });

  for (const [engine, browserType] of [["Chromium", chromium], ["Firefox", firefox], ["WebKit", webkit]] as const satisfies ReadonlyArray<readonly [string, BrowserType]>) {
    it(`${engine} hydrates shared plain ranges with editable controls through transfers and reconnect`, async () => {
      const browser = await launchParityBrowser(browserType);
      try {
        const page = await browser.newPage(), errors: string[] = [];
        page.on("pageerror", error => errors.push(error.message));
        page.on("console", message => { if (message.type() === "error" || message.type() === "warning" && !message.text().startsWith("Feature flags ")) errors.push(message.text()); });
        await page.setContent(`<div id="mount">${plainServer}</div>`);
        const read = () => page.locator("[data-plain-case] > section").evaluateAll(sections => sections.map(section => Array.from(section.children, child => [child.localName, child.textContent])));
        assert.deepEqual(await read(), plainSlotExpected);
        assert.deepEqual(await page.locator("[data-hand-empty] p, [data-hand-empty] b").allTextContents(), ["", "Second"]);
        await page.locator("[data-moving-plain] input").fill("Before hydration");
        await page.locator("[data-repeated-plain] input").fill("Kept");
        await page.addScriptTag({ path: plainHydrate });
        const frames = () => page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        await frames(); assert.deepEqual(errors, []); assert.deepEqual(await read(), plainSlotExpected);
        assert.equal(await page.locator("[data-moving-plain] input").inputValue(), "Before hydration");
        assert.equal(await page.locator("[data-repeated-plain] input").inputValue(), "Kept");
        const editable = async (): Promise<void> => {
          for (const selector of ["[data-moving-plain] input", "[data-repeated-plain] input"]) {
            const input = page.locator(selector); assert.equal(await input.count(), 1);
            await input.fill("Edited"); assert.equal(await input.inputValue(), "Edited");
            assert.ok(await input.evaluate(node => node === node.ownerDocument.activeElement));
          }
        };
        await editable();
        assert.equal(await page.locator("[data-hand-card] mark").textContent(), "A");
        await page.evaluate(() => (window as any).updatePlainLabel()); await frames();
        assert.equal(await page.locator("[data-hand-card] mark").textContent(), "B");
        const handInput = page.locator("[data-hand-card] input");
        await handInput.fill("Typed"); await frames();
        assert.equal(await page.locator("[data-hand-card] mark").textContent(), "Typed");
        assert.ok(await handInput.evaluate(node => node === node.ownerDocument.activeElement), "reactive slot updates keep native focus");
        await page.locator("[data-hand-counter]").click(); await frames();
        assert.equal(await page.locator("[data-hand-counter]").textContent(), "Context:1");
        await page.locator("[data-hand-live] [data-hand-toggle]").click(); await frames();
        const handCounter = page.locator("[data-hand-live] b [data-hand-counter]");
        const count = Number((await handCounter.textContent())!.split(":")[1]);
        assert.equal(await handCounter.textContent(), `Context:${count}`);
        await handCounter.click(); await frames(); assert.equal(await handCounter.textContent(), `Context:${count + 1}`);
        assert.deepEqual(await page.locator("[data-hand-empty] p, [data-hand-empty] b").allTextContents(), ["", "Second"]);
        for (const [action, expected] of [
          ["borrowed", [["b", "Plain"]]], ["borrowed", [["p", "BorrowedFallback"], ["b", "Plain"]]],
          ["root", [["p", "Plain"]]], ["root", [["p", "Plain"], ["b", "OwnFallback"]]],
        ] as const) {
          await page.locator(`[data-plain-action="${action}"]`).click(); await frames(); assert.deepEqual(errors, []); await editable();
          assert.deepEqual(await page.locator("[data-moving-plain] > p, [data-moving-plain] > b").evaluateAll(nodes => nodes.map(node => [node.localName, node.textContent])), expected);
          const owner = expected.some(([name, text]) => name === "b" && text === "Plain") ? "b" : "p";
          for (const text of ["", "Plain"]) {
            await page.locator('[data-plain-action="content"]').click(); await frames();
            assert.equal(await page.locator(`[data-moving-plain] > ${owner}`).textContent(), text); await editable();
          }
        }
        await page.locator('[data-plain-action="first"]').click(); await frames(); await editable();
        assert.ok(await page.locator("[data-repeated-plain] footer").evaluate(node => node.matches(":last-child")));
        assert.deepEqual(await page.locator("[data-repeated-lazy] i").allTextContents(), ["Fresh", "Fresh"]);
        assert.deepEqual(await page.locator("[data-default-lazy] i").allTextContents(), ["DefaultFresh", "DefaultFresh"]);
        await page.evaluate(async () => {
          const root = document.querySelector("#mount")!, parent = root.parentNode!, after = root.nextSibling;
          root.remove(); await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
          parent.insertBefore(root, after);
        });
        await frames(); await editable(); assert.deepEqual(await read(), plainSlotExpected);
        await page.evaluate(() => (window as any).finishPlain()); await frames();
        assert.equal(await page.locator("#mount").textContent(), ""); assert.deepEqual(errors, []);
      } finally { await browser.close(); }
    });

    it(`${engine} renders editable inputs when a single conditional outlet closes and reopens`, async () => {
      const browser = await launchParityBrowser(browserType);
      try {
        for (const hydrated of [false, true]) {
          const page = await browser.newPage(), errors: string[] = [];
          page.on("pageerror", error => errors.push(error.message));
          page.on("console", message => { if (message.type() === "error" || message.type() === "warning" && !message.text().startsWith("Feature flags ")) errors.push(message.text()); });
          await page.setContent(`<div id="mount">${hydrated ? plainServer : ""}</div>`);
          if (hydrated) for (const name of ["direct", "ancestor", "match"]) await page.locator(`[data-single-slot="${name}"] input`).fill("Edited");
          await page.addScriptTag({ path: hydrated ? plainHydrate : plainFresh });
          const frames = () => page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
          await frames();
          for (const name of ["direct", "ancestor", "match", "closed", "lazy"]) {
            const card = page.locator(`[data-single-slot="${name}"]`), input = card.locator("input");
            if (name === "closed") {
              assert.equal(await input.count(), 0);
              await card.locator("button").click(); await frames();
            }
            if (hydrated && ["direct", "ancestor", "match"].includes(name)) assert.equal(await input.inputValue(), "Edited");
            for (let cycle = 0; cycle < 2; cycle++) {
              await input.fill("Edited"); assert.equal(await input.inputValue(), "Edited");
              await card.locator("button").click(); await frames(); assert.equal(await input.count(), 0);
              await card.locator("button").click(); await frames();
              assert.equal(await input.count(), 1); await input.fill("Reopened"); assert.equal(await input.inputValue(), "Reopened");
              assert.ok(await card.locator("footer").evaluate(node => node.matches(":last-child")));
            }
          }
          await page.evaluate(() => (window as any).finishPlain()); await frames();
          assert.equal(await page.locator("#mount").textContent(), ""); assert.deepEqual(errors, []);
          await page.close();
        }
      } finally { await browser.close(); }
    });

    it(`${engine} places an accepted root once with working state and context at each receiving outlet`, async () => {
      const browser = await launchParityBrowser(browserType);
      try {
        for (const hydrated of [false, true]) {
          const page = await browser.newPage(), errors: string[] = [];
          page.on("pageerror", error => errors.push(error.message));
          page.on("console", message => { if (message.type() === "error" || message.type() === "warning" && !message.text().startsWith("Feature flags ")) errors.push(message.text()); });
          await page.setContent(`<div id="mount">${hydrated ? plainServer : ""}</div>`);
          const list = page.locator("[data-receiving-list]"), item = list.locator("[data-receiving-item]"), input = item.locator("input");
          const read = () => list.locator(":scope > p, :scope > div").evaluateAll(nodes => nodes.map(node => [node.localName, node.querySelector("[data-receiving-item] button")?.textContent ?? node.textContent]));
          if (hydrated) {
            assert.deepEqual(await read(), [["p", "Before:0:Tone"], ["div", "SecondFallback"]]);
            assert.equal(await item.count(), 1); await input.fill("Edited");
          }
          await page.addScriptTag({ path: hydrated ? plainHydrate : plainFresh });
          const frames = () => page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
          await frames();
          assert.deepEqual(await read(), [["p", "Before:0:Tone"], ["div", "SecondFallback"]]);
          assert.equal(await list.locator("output").textContent(), "1"); assert.equal(await item.count(), 1);
          if (hydrated) assert.equal(await input.inputValue(), "Edited");
          let label = "Before";
          const interact = async () => {
            assert.equal(await item.count(), 1); assert.equal(await list.locator("output").textContent(), "1");
            const button = item.locator("button"), text = (await button.textContent())!;
            assert.match(text, new RegExp(`^${label}:\\d+:Tone$`));
            const count = Number(text.split(":")[1]);
            await input.fill("Edited"); assert.equal(await input.inputValue(), "Edited");
            await button.click(); await frames(); assert.equal(await button.textContent(), `${label}:${count + 1}:Tone`);
            assert.equal(await list.locator("[data-receiving-detail]").textContent(), String(count + 1));
          };
          await interact();
          await list.locator('[data-receiving-action="first"]').click(); await frames();
          assert.equal((await read())[0]![0], "div"); await interact();
          await list.locator('[data-receiving-action="second"]').click(); await frames(); assert.equal(await item.count(), 0);
          await page.locator("[data-receiving-update]").click(); await frames(); label = "After";
          await list.locator('[data-receiving-action="first"]').click(); await frames(); await interact();
          await list.locator('[data-receiving-action="second"]').click(); await frames();
          assert.equal((await read())[1]![1], "SecondFallback"); await interact();
          assert.ok(await list.locator("footer").evaluate(node => node.matches(":last-child")));
          await page.evaluate(() => (window as any).finishPlain()); await frames();
          assert.equal(await page.locator("#mount").textContent(), ""); assert.deepEqual(errors, []);
          await page.close();
        }
      } finally { await browser.close(); }
    });

    it(`${engine} renders, updates and hydrates the tables like live`, async () => {
      const browser = await launchParityBrowser(browserType);
      try {
        const pages: Record<"live" | "vue" | "hydrated", Page> = { live: await browser.newPage(), vue: await browser.newPage(), hydrated: await browser.newPage() };
        const errors: string[] = [];
        const warnings: Record<keyof typeof pages, string[]> = { live: [], vue: [], hydrated: [] };
        for (const [name, page] of Object.entries(pages) as [keyof typeof pages, Page][]) {
          page.on("pageerror", (error) => errors.push(`${name}: ${error.message}`));
          page.on("console", (message) => {
            if (message.type() === "error") errors.push(`${name}: ${message.text()}`);
            if (message.type() === "warning") warnings[name].push(message.text());
          });
        }
        await pages.live.setContent(`${source}<div id="mount"><x-app></x-app></div>`);
        await pages.live.addScriptTag({ path: live });
        await pages.live.evaluate(`window.HtmlRuntime.observeDocument(document)`);
        await pages.live.evaluate(LIVE_CONTROLLERS);
        await pages.vue.setContent(`<div id="mount"></div>`);
        await pages.vue.addScriptTag({ path: fresh });
        await pages.hydrated.setContent(`<div id="mount">${server}</div>`);
        const expected = await tables(pages.live);
        // The server's tables are complete, so its markup is the table the live runtime renders.
        // The controller runs in the browser, so the server's markup has no list it wrote.
        const bare = (list: readonly string[]) => list.map((table) => table.replace(/ columns: .*$/, ""));
        assert.deepEqual(bare(await tables(pages.hydrated)), bare(expected));
        await pages.hydrated.evaluate(`window.serverCells = Array.from(document.querySelectorAll("td"))`);
        await pages.hydrated.addScriptTag({ path: hydrate });
        assert.equal(expected[0]!.startsWith("<table><caption>4 columns</caption>"), true);
        assert.match(expected[0]!, /<td><b>Desk lamp:quiet:compact<\/b>49<\/td>/);
        assert.deepEqual({ vue: await tables(pages.vue, expected), hydrated: await tables(pages.hydrated, expected) }, { vue: expected, hydrated: expected });
        assert.equal(await pages.hydrated.evaluate(`window.serverCells.every((cell) => cell.isConnected)`), true, "hydration kept the server's cells");

        const step = async (button: string, check?: (tables: readonly string[]) => readonly string[] | void): Promise<void> => {
          for (const page of Object.values(pages)) await page.evaluate(mark);
          for (const page of Object.values(pages)) await page.locator(`button.${button}`).click();
          await pages.live.waitForTimeout(50);
          await pages.live.evaluate(LIVE_CONTROLLERS);
          await pages.live.waitForTimeout(20);
          const read = await tables(pages.live);
          const now = check?.(read) ?? read;
          const [cells, ...others] = await Promise.all(Object.values(pages).map((page) => page.evaluate(marks)));
          assert.deepEqual({ vue: await tables(pages.vue, now), hydrated: await tables(pages.hydrated, now) }, { vue: now, hydrated: now }, button);
          // Cells keep their nodes as the columns change, as live keeps them.
          assert.deepEqual(others, [cells, cells], `${button} cells`);
        };
        await step("toggle", (now) => assert.match(now[0]!, /^<table><caption>5 columns<\/caption><thead><tr><th scope="col">Id<\/th>/));
        await step("swap", (now) => assert.match(now[0]!, /<th scope="col">P<\/th><th scope="col">N<\/th><\/tr>/));
        await step("add", (now) => assert.match(now[0]!, /<tr><td>3<\/td><td>Pen<\/td><td><b>Pen:quiet:compact<\/b>2<\/td>/));
        await step("toggle");
        const kept = await Promise.all(Object.values(pages).map((page) => page.evaluate(`window.keptNote = document.querySelectorAll("table")[1].querySelector("td b"); window.keptNote.textContent`)));
        assert.deepEqual(kept, ["kept", "kept", "kept"]);
        await step("note");
        const notes = await Promise.all(Object.values(pages).map((page) => page.evaluate(`[Array.from(document.querySelectorAll("table")[1].querySelectorAll("td"), (cell) => cell.textContent.trim()), window.keptNote.isConnected]`)));
        assert.deepEqual(notes, Array.from({ length: 3 }, () => [["none", "kept", "none"], true]));

        // The same table and warnings as live, for the stray text, the preset and the plain content of a slot with props.
        await step("warn", (now) => assert.match(now[2]!, /<tbody><tr><td>A<\/td><td><\/td><\/tr><\/tbody>/));
        const accepting = (list: readonly string[]) => [...new Set(list.filter((text) => /left out|has props/.test(text)).map((text) => text.replace(/^.*?(?=`)/, "")))].sort();
        const left = accepting(warnings.live);
        assert.equal(left.length, 3);
        assert.deepEqual({ vue: accepting(warnings.vue), hydrated: accepting(warnings.hydrated) }, { vue: left, hydrated: left });
        // An accepted child's \`<template slot>\` renders at every outlet; its plain content at the first, then the next when that one goes.
        await step("unlead");
        for (const button of ["widen", "retag", "widen"]) await step(button);
        const final = await tables(pages.live);
        assert.match(final[3]!, /<tfoot><tr><td><u>n<\/u><u>n<\/u><\/td><td>-<\/td><td>-<em>4px<\/em><\/td><td>-<em>4px<\/em><\/td>/);
        assert.match(final[3]!, /<b>W:quiet:compact<\/b>/);
        // Entries hold the props as each column resolves them: a rejected value takes the default.
        assert.match(final[0]!, /columns: Name:1,-:2,P:1,N:1$/);
        // Without a public root URL the generated definitions have no file, so their warnings start at the code.
        const outlets = (list: readonly string[]) => [...new Set(list.filter((text) => /does not declare|declares as required/.test(text)).map((text) => text.replace(/^.*?HR007: /, "HR007: ")))].sort();
        assert.equal(outlets(warnings.live).length, 2);
        assert.deepEqual({ vue: outlets(warnings.vue), hydrated: outlets(warnings.hydrated) }, { vue: outlets(warnings.live), hydrated: outlets(warnings.live) });
        assert.deepEqual(errors, []);
        assert.deepEqual(warnings.hydrated.filter((text) => !text.startsWith("Feature flags ") && /hydration|mismatch/i.test(text)), []);
      } finally {
        await browser.close();
      }
    });
  }
});
