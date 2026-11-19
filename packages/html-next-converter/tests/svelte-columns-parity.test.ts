import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, it } from "vitest";

import { build } from "esbuild";
import { chromium, firefox, webkit, type BrowserType, type Page } from "playwright";

import { convertComponents } from "../src/index.js";
import { launchParityBrowser } from "../../html-next/tests/pixel-parity.js";
import { plainSlotFiles, plainSlotInvocations, plainSlotExpected, dynamicPlainSource, repeatedPlainSource } from "../../html-next/tests/fixtures/plain-slot-ownership.js";
import { sveltePlugin } from "./helpers/svelte.js";

/**
 * Columns as markup (https://nextwebwg.org/declarative-components/components#columns-as-markup) in
 * converted Svelte, against the live runtime: the spec's data table, a consumer `$if` column, a keyed
 * `$each` column list reordered with its cells following, context read from cell content (column, then
 * table), `$columns.length` read before the header row, warnings for content the slot leaves out, and
 * server rendering with hydration. A column's root comes before its `<defs>`, as the live parser needs.
 */
const enabled = process.env.HTMLNEXT_TARGET_TEST === "1";
const nodeModules = fileURLToPath(new URL("../node_modules", import.meta.url));

const source = `<template component="x-column" status="early" summary="One column of x-datatable." controller="./column.js"><th $attributes scope="col"><slot name="header">{$header}</slot></th>
  <defs>
    <prop name="field" type="string">The row field a cell shows when no cell content is given.</prop>
    <prop name="header" type="string">The header text.</prop>
    <prop name="width" type="number">The column's width.</prop>
    <state name="tone" type="string" value="quiet"></state>
    <slot name="header"></slot>
    <slot name="cell"><prop name="row" type="object" required>The row this cell shows.</prop></slot>
    <slot name="note"></slot>
    <slot name="total"><prop name="size" type="number" default="1">The size.</prop><prop name="label" type="string" required>The label.</prop></slot>
  </defs>
</template>
<template component="x-datatable" status="early" summary="A table whose columns are its x-column children." controller="./table.js">
  <defs>
    <prop name="rows" type="list(object({ id: number, name: string, price: number }))" required>One entry per table row.</prop>
    <state name="density" type="string" value="compact"></state>
    <state name="notes" type="boolean" value="true"></state>
    <slot accepts="x-column" as="columns"></slot>
  </defs>
  <table>
    <caption>{$columns.length} columns</caption>
    <thead><tr><template $slot></template></tr></thead>
    <tbody>
      <tr $each="row of $rows" $key="$row.id">
        <td $each="column of $columns" $key="$column">
          <slot of="$column" name="cell" from:row="$row">{$row[$column.field]}</slot>
        </td>
      </tr>
    </tbody>
    <tfoot>
      <tr $if="$notes"><td $each="column of $columns" $key="$column"><slot of="$column" name="note">-</slot>|<slot of="$column" name="total" size="3" extra="x"></slot></td></tr>
      <tr><td $each="column of $columns" $key="$column"><slot of="$column" name="note">=</slot>|<slot of="$column" name="total" from:size="$density"></slot></td></tr>
    </tfoot>
  </table>
</template>
<template component="x-badge" status="early" summary="Reads both table contexts.">
  <defs>
    <prop name="text" type="string">Text.</prop>
    <context name="tone" from="x-column"></context>
    <context name="density" from="x-datatable"></context>
  </defs>
  <b>{$text}:{$tone}:{$density}</b>
</template>
<template component="x-column-preset" status="early" summary="A preset of x-column."><x-column field="name" class="preset"></x-column></template>
<template component="page-products" status="early" summary="Products.">
  <defs>
    <state name="products" type="list(object({ id: number, name: string, price: number }))"
      value="[{ id: 1, name: 'Desk lamp', price: 49 }, { id: 2, name: 'Notebook', price: 6.5 }]"></state>
    <state name="showId" type="boolean" value="false"></state>
    <state name="extra" type="list(object({ key: string, label: string }))"
      value="[{ key: 'name', label: 'N' }, { key: 'price', label: 'P' }]"></state>
    <handler name="toggle"><set name="showId" expr:value="not $showId"></set></handler>
    <handler name="swap"><set name="extra" expr:value="[{ key: 'price', label: 'P' }, { key: 'name', label: 'N' }]"></set></handler>
    <handler name="add"><set name="products" expr:value="[{ id: 1, name: 'Desk lamp', price: 49 }, { id: 2, name: 'Notebook', price: 6.5 }, { id: 3, name: 'Pen', price: 2 }]"></set></handler>
  </defs>
  <main id="products">
    <button type="button" class="toggle" on:click="toggle">Id</button>
    <button type="button" class="swap" on:click="swap">Swap</button>
    <button type="button" class="add" on:click="add">Add</button>
    <x-datatable from:rows="$products">
      <x-column $if="$showId" field="id" header="Id"></x-column>
      <x-column field="name" header="Name" width="40"><em slot="note">n</em></x-column>
      <x-column class="numeric">
        <abbr slot="header" title="Price in US dollars">Price</abbr>
        <template slot="cell"><x-badge from:text="$row.name"></x-badge>{$row.price}</template>
        <template slot="note"><i>t</i></template>
        <template slot="total">{$size}</template>
      </x-column>
      <x-column $each="column of $extra" $key="$column.key" from:field="$column.key" from:header="$column.label"></x-column>
    </x-datatable>
  </main>
</template>
<template component="page-strays" status="early" summary="Content the columns slot leaves out, and columns under $with and $match.">
  <defs>
    <state name="mode" type="string" value="a"></state>
    <state name="picked" type="string" value="name"></state>
    <state name="count" type="number" value="5"></state>
    <handler name="flip"><set name="mode" value="b"></set><set name="picked" value="price"></set></handler>
  </defs>
  <section id="strays"><button type="button" class="flip" on:click="flip">Flip</button><x-datatable rows='[{"id":1,"name":"A","price":1}]'><x-column field="name"></x-column><p>no</p>stray<x-column-preset></x-column-preset><x-column class="stray"><span slot="cell">plain</span></x-column><template $with="$picked as first"><x-column from:field="$first" header="W"></x-column></template><template $match="$mode as m"><x-column $when="$m = 'a'" field="id" header="A"></x-column><x-column $else field="price" header="B" width="wide"></x-column></template><x-column from:field="$count" header="Bad"></x-column></x-datatable></section>
</template>`;
const emptyPlain = dynamicPlainSource.replaceAll("x-moving", "x-empty").replaceAll("data-moving-plain", "data-empty-list")
  .replaceAll("data-plain-action", "data-empty-action").replace('<input slot="cell" value="Initial">', "");
const conditionalPlain = `<template component="x-single-card"><defs><state name="open" type="boolean" value="true"></state><state name="tone" type="string" value="Owner"></state>
<handler name="toggle"><set name="open" expr:value="not $open"></set></handler></defs><section data-single-plain><button data-single-toggle on:click="toggle">Toggle</button><p $if="$open"><slot></slot></p><footer>Tail</footer></section></template>
<template component="x-slot-counter"><defs><context name="tone" from="x-single-card"></context><state name="count" type="number" value="0"></state><handler name="add"><set name="count" expr:value="$count + 1"></set></handler></defs><button data-slot-counter on:click="add">{$tone}:{$count}</button></template>
<template component="x-switch-entry"><defs><prop name="label" type="string" required>Label.</prop><state name="tone" type="string" from="$label"></state><slot name="cell"></slot></defs><b>Entry</b></template>
<template component="x-switch-label"><defs><context name="tone" from="x-switch-entry"></context></defs><strong>{$tone}</strong></template>
<template component="x-switch-list"><defs><slot accepts="x-switch-entry" as="entries"></slot><state name="picked" type="number" value="0"></state><state name="first" type="boolean" value="true"></state><state name="second" type="boolean" value="false"></state>
<handler name="pick"><set name="picked" expr:value="1"></set></handler><handler name="toggleFirst"><set name="first" expr:value="not $first"></set></handler><handler name="toggleSecond"><set name="second" expr:value="not $second"></set></handler></defs>
<section data-switch-list><button data-switch-action="pick" on:click="pick">Pick</button><button data-switch-action="first" on:click="toggleFirst">First</button><button data-switch-action="second" on:click="toggleSecond">Second</button><slot></slot><p $if="$first"><slot of="$entries[$picked]" name="cell">FirstFallback</slot></p><div $if="$second"><slot of="$entries[1]" name="cell">SecondFallback</slot></div></section></template>
<template component="x-switch-page"><x-switch-list><x-switch-entry label="Alpha"><x-switch-label slot="cell"></x-switch-label></x-switch-entry><x-switch-entry label="Beta"><x-switch-label slot="cell"></x-switch-label></x-switch-entry></x-switch-list></template>
<template component="x-plain-page"><main>${plainSlotInvocations}<x-moving-page></x-moving-page><x-repeat-page></x-repeat-page><x-empty-page></x-empty-page><x-single-card><i>Single</i><input value="Initial"><x-slot-counter></x-slot-counter></x-single-card><x-switch-page></x-switch-page></main></template>`;
const plainSource = Object.values(plainSlotFiles).join("") + dynamicPlainSource + repeatedPlainSource + emptyPlain + conditionalPlain;
const columnController = `export default function initialize(host) { (window.columnHosts ??= []).push(host); }`;
const tableController = `export default function initialize(host) { (window.tableHosts ??= []).push(host); }`;

/** A table's markup without marks, runtime attributes or carriers. */
const readTable = (selector: string): string => `(() => {
  const read = (node) => {
    if (node.nodeType === 3) return node.data.trim();
    if (node.nodeType !== 1 || node.localName === "template") return "";
    const keep = ["class", "scope", "title", "slot"].filter((name) => node.hasAttribute(name)).map((name) => " " + name + '="' + node.getAttribute(name) + '"');
    return "<" + node.localName + keep.join("") + ">" + Array.from(node.childNodes, read).join("") + "</" + node.localName + ">";
  };
  return read(document.querySelector(${JSON.stringify(selector)}));
})()`;

const LEFT_OUT = [
  /`x-datatable`'s default slot accepts `x-column`; this `<p>` is left out\./,
  /`x-datatable`'s default slot accepts `x-column`; this text is left out\./,
  /`<x-column-preset>` is a preset of `x-column`.*not supported yet/,
  /`cell` has props, so its content is a `<template slot="cell">`\./,
  /HR007: <slot of name="total"> gives prop `extra`, which `x-column`'s slot `total` does not declare\./,
  /HR007: <slot of name="total"> must give prop `label`, which `x-column`'s slot `total` declares as required\./,
  /HR007: Slot `total` prop `size` does not satisfy its declared type `number`\./,
];

/** What the tables' controllers read: each list's entries, the table's default slot, and each column's placed cells and notes. */
const readHosts = (target: "live" | "svelte"): string => `(() => {
  const host = (selector) => ${target === "live" ? "window.HtmlRuntime.getComponentHost(document.querySelector(selector))"
    : "[...window.tableHosts, ...window.columnHosts].find((candidate) => candidate.root === document.querySelector(selector))"};
  return ["#products table", "#strays table"].map((selector) => {
    const table = host(selector);
    return { columns: Array.from(table.state.columns, (entry) => [entry.field, entry.header, entry.width]), slots: table.slots.default.length,
      cells: Array.from(document.querySelectorAll(selector + " thead th:not(.preset, .stray)"), (th) => {
        const column = host(selector + " thead th:nth-child(" + (Array.from(th.parentNode.children).indexOf(th) + 1) + ")");
        return [column.slots.cell.length, column.slots.note.map((element) => element.localName).join()];
      }) };
  });
})()`;

describe.skipIf(!enabled)("Svelte columns as markup parity", () => {
  let directory = "";
  let liveBundle = "";
  let svelteBundle = "";
  let serverMarkup = "";
  let plainBundle = "";
  let plainMarkup = "";
  const serverWarnings: string[] = [];

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-svelte-columns-"));
    await symlink(nodeModules, join(directory, "node_modules"), "dir");
    await mkdir(join(directory, "components"));
    await writeFile(join(directory, "components/table.html"), source + plainSource);
    await writeFile(join(directory, "components/column.js"), columnController);
    await writeFile(join(directory, "components/table.js"), tableController);
    const out = join(directory, "svelte");
    const manifest = await convertComponents({ mode: "application", target: "svelte", root: directory, outDirectory: out, entries: ["components/**"] });
    const artifact = (tag: string): string => manifest.components.find((component) => component.tag === tag)!.artifact;
    await writeFile(join(out, "mount.ts"), `import { mount, hydrate } from "svelte"; import App from "./${artifact("page-products")}"; import Strays from "./${artifact("page-strays")}";
const target = document.querySelector("#mount")!;
if (target.hasChildNodes()) hydrate(App, { target }); else mount(App, { target });
mount(Strays, { target: document.querySelector("#strays-mount")! });`);
    svelteBundle = join(directory, "svelte.js");
    await build({ entryPoints: [join(out, "mount.ts")], outfile: svelteBundle, bundle: true, format: "iife", platform: "browser",
      target: ["es2022"], loader: { ".css": "empty" }, plugins: [sveltePlugin("client")] });
    await writeFile(join(out, "server.ts"), `import { render } from "svelte/server"; import App from "./${artifact("page-products")}"; import Strays from "./${artifact("page-strays")}";
export const html = () => { void render(Strays).body; return render(App).body; };`);
    await writeFile(join(out, "plain.ts"), `import { mount, hydrate, unmount } from "svelte"; import App from "./${artifact("x-plain-page")}";
const target = document.querySelector("#mount")!; const app = target.hasChildNodes() ? hydrate(App, { target }) : mount(App, { target }); window.finishPlain = () => unmount(app);`);
    await build({ entryPoints: [join(out, "plain.ts")], outfile: plainBundle = join(directory, "plain.js"), bundle: true, format: "iife", platform: "browser",
      target: ["es2022"], loader: { ".css": "empty" }, plugins: [sveltePlugin("client")] });
    await writeFile(join(out, "plain-server.ts"), `import { render } from "svelte/server"; import App from "./${artifact("x-plain-page")}"; export const html = () => render(App).body;`);
    const plainServer = join(directory, "plain-server.mjs");
    await build({ entryPoints: [join(out, "plain-server.ts")], outfile: plainServer, bundle: true, format: "esm", platform: "node", packages: "external", plugins: [sveltePlugin("server")] });
    plainMarkup = (await import(pathToFileURL(plainServer).href) as { html(): string }).html();
    const serverBundle = join(directory, "server.mjs");
    await build({ entryPoints: [join(out, "server.ts")], outfile: serverBundle, bundle: true, format: "esm", platform: "node",
      packages: "external", loader: { ".css": "empty" }, plugins: [sveltePlugin("server")] });
    const warn = console.warn;
    console.warn = (message: unknown) => { serverWarnings.push(String(message)); };
    try {
      serverMarkup = (await import(pathToFileURL(serverBundle).href) as { html: () => string }).html();
    } finally { console.warn = warn; }
    liveBundle = join(directory, "live.js");
    await build({ entryPoints: [fileURLToPath(new URL("../../html-next/src/live.ts", import.meta.url))], outfile: liveBundle,
      bundle: true, format: "iife", globalName: "HtmlRuntime", platform: "browser", target: ["es2022"] });
  }, 180_000);

  afterAll(async () => { if (directory !== "") await rm(directory, { recursive: true, force: true }); });

  it("server rendering lists every column before the table renders, and warns for content it leaves out", () => {
    assert.match(serverMarkup, /<caption>4 columns<\/caption>/);
    assert.match(serverMarkup, /<b[^>]*>Desk lamp:quiet:compact<\/b>/);
    for (const pattern of LEFT_OUT) assert.ok(serverWarnings.some((warning) => pattern.test(warning)), String(pattern));
  });

  const open = async (page: Page, target: "live" | "svelte", hydrate: boolean, warnings: string[], errors: string[]): Promise<void> => {
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "warning") warnings.push(message.text());
      if (message.type() === "error") errors.push(message.text());
    });
    if (target === "live") {
      // The live page reads hosts through the runtime, so its components name no controller to load.
      await page.setContent(`${source.replaceAll(/ controller="[^"]*"/g, "")}<div id="mount"><page-products></page-products></div><div id="strays-mount"><page-strays></page-strays></div>`);
      await page.addScriptTag({ path: liveBundle });
      await page.evaluate(`window.HtmlRuntime.observeDocument(document)`);
    } else {
      await page.setContent(`<div id="mount">${hydrate ? serverMarkup : ""}</div><div id="strays-mount"></div>`);
      await page.evaluate(`window.served = Array.from(document.querySelectorAll("#mount th, #mount td, #mount td *"))`);
      await page.addScriptTag({ path: svelteBundle });
      // Hydration adopts the server's cells, the placed cell content among them.
      if (hydrate) assert.deepEqual(await page.evaluate(`({ served: window.served.length > 10, lost: window.served.filter((node) => !node.isConnected).length })`), { served: true, lost: 0 });
    }
    await page.locator("#products caption").waitFor();
    if (target === "svelte") await page.waitForFunction(`window.tableHosts?.length === 2 && window.columnHosts?.length >= 9`);
  };

  for (const [engine, browserType] of [["Chromium", chromium], ["Firefox", firefox], ["WebKit", webkit]] as const satisfies ReadonlyArray<readonly [string, BrowserType]>) {
    it(`${engine} changes a populated borrowed outlet's context and releases its latest entry`, async () => {
      const browser = await launchParityBrowser(browserType);
      try {
        for (const hydrated of [false, true]) {
          const page = await browser.newPage(), errors: string[] = [];
          page.on("pageerror", error => errors.push(error.message));
          await page.setContent(`<div id="mount">${hydrated ? plainMarkup : ""}</div>`);
          await page.addScriptTag({ path: plainBundle });
          const settle = () => page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
          const list = page.locator("[data-switch-list]");
          await settle(); assert.equal(await list.locator("p strong").textContent(), "Alpha");
          await list.locator('[data-switch-action="pick"]').click(); await settle();
          assert.equal(await list.locator("p strong").textContent(), "Beta");
          await list.locator('[data-switch-action="second"]').click(); await settle();
          assert.equal(await list.locator("div").textContent(), "SecondFallback");
          await list.locator('[data-switch-action="first"]').click(); await settle();
          assert.equal(await list.locator("p").count(), 0); assert.equal(await list.locator("div strong").textContent(), "Beta");
          await list.locator('[data-switch-action="first"]').click(); await settle();
          assert.equal(await list.locator("p").textContent(), "FirstFallback");
          await list.locator('[data-switch-action="second"]').click(); await settle();
          assert.equal(await list.locator("p strong").textContent(), "Beta"); assert.equal(await list.locator("strong").count(), 1);
          await page.evaluate(() => (window as any).finishPlain()); await settle();
          assert.equal(await page.locator("#mount").textContent(), ""); assert.deepEqual(errors, []);
          await page.close();
        }
      } finally { await browser.close(); }
    });

    it(`${engine} renders editable plain slots through SSR hydration, transfers and conditional outlets`, async () => {
      const browser = await launchParityBrowser(browserType);
      try {
        for (const hydrated of [false, true]) {
          const page = await browser.newPage(), errors: string[] = [];
          page.on("pageerror", error => errors.push(error.message));
          page.on("console", message => { if (message.type() === "error" || message.type() === "warning") errors.push(message.text()); });
          await page.setContent(`<div id="mount">${hydrated ? plainMarkup : ""}</div>`);
          const read = () => page.locator("[data-plain-case] > section").evaluateAll(nodes => nodes.map(section => Array.from(section.children, node => [node.localName, node.textContent])));
          if (hydrated) assert.deepEqual(await read(), plainSlotExpected);
          if (hydrated) for (const selector of ["[data-moving-plain] input", "[data-repeated-plain] input", "[data-single-plain] input"]) await page.locator(selector).fill("Edited");
          await page.addScriptTag({ path: plainBundle });
          const frames = () => page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
          await frames(); assert.deepEqual(await read(), plainSlotExpected); assert.deepEqual(errors, []);
          if (hydrated) for (const selector of ["[data-moving-plain] input", "[data-repeated-plain] input", "[data-single-plain] input"]) assert.equal(await page.locator(selector).inputValue(), "Edited");
          const editable = async () => {
            for (const selector of ["[data-moving-plain] input", "[data-repeated-plain] input"]) {
              const input = page.locator(selector); assert.equal(await input.count(), 1);
              await input.fill("Edited"); assert.equal(await input.inputValue(), "Edited");
              assert.ok(await input.evaluate(node => node === node.ownerDocument.activeElement));
            }
            assert.deepEqual(errors, []);
          };
          for (const action of ["borrowed", "borrowed", "root", "root"]) {
            await page.locator(`[data-plain-action="${action}"]`).click(); await frames(); await editable();
            for (const expected of [0, 1]) {
              await page.locator('[data-plain-action="content"]').click(); await frames();
              assert.equal(await page.locator("[data-moving-plain] i").count(), expected); await editable();
            }
          }
          await page.locator('[data-plain-action="first"]').click(); await frames(); await editable();
          assert.ok(await page.locator("[data-repeated-plain] footer").evaluate(node => node.matches(":last-child")));
          assert.deepEqual(await page.locator("[data-repeated-lazy] i").allTextContents(), ["Fresh", "Fresh"]);
          assert.deepEqual(await page.locator("[data-default-lazy] i").allTextContents(), ["DefaultFresh", "DefaultFresh"]);
          const empty = () => page.locator("[data-empty-list] > p, [data-empty-list] > b").evaluateAll(nodes => nodes.map(node => [node.localName, node.textContent]));
          assert.deepEqual(await empty(), [["p", "Plain"], ["b", "OwnFallback"]]);
          await page.locator('[data-empty-action="content"]').click(); await frames();
          assert.deepEqual(await empty(), [["p", "BorrowedFallback"], ["b", "OwnFallback"]]);
          await page.locator('[data-empty-action="content"]').click(); await frames();
          assert.deepEqual(await empty(), [["p", "Plain"], ["b", "OwnFallback"]]);
          await page.locator("[data-slot-counter]").click(); await frames();
          assert.equal(await page.locator("[data-slot-counter]").textContent(), "Owner:1");
          await page.locator("[data-single-toggle]").click(); await frames();
          assert.equal(await page.locator("[data-single-plain] input").count(), 0);
          await page.locator("[data-single-toggle]").click(); await frames();
          const reopened = page.locator("[data-single-plain] input"); await reopened.fill("Reopened"); assert.equal(await reopened.inputValue(), "Reopened");
          const count = Number((await page.locator("[data-slot-counter]").textContent())!.split(":")[1]);
          assert.equal(await page.locator("[data-slot-counter]").textContent(), `Owner:${count}`);
          await page.locator("[data-slot-counter]").click(); await frames(); assert.equal(await page.locator("[data-slot-counter]").textContent(), `Owner:${count + 1}`);
          await page.evaluate(async () => { const root = document.querySelector("#mount")!, parent = root.parentNode!, next = root.nextSibling;
            root.remove(); await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))); parent.insertBefore(root, next); });
          await frames(); await editable(); assert.deepEqual(await read(), plainSlotExpected);
          await page.evaluate(() => (window as any).finishPlain()); await frames();
          assert.equal(await page.locator("#mount").textContent(), ""); assert.deepEqual(errors, []);
          await page.close();
        }
      } finally { await browser.close(); }
    });

    for (const hydrate of [false, true]) {
      it(`${engine} ${hydrate ? "hydrates" : "mounts"} the data table as live renders it, following $if, keyed $each and context`, async () => {
        const browser = await launchParityBrowser(browserType);
        try {
          const live = await browser.newPage();
          const svelte = await browser.newPage();
          const liveWarnings: string[] = [];
          const svelteWarnings: string[] = [];
          const errors: string[] = [];
          await open(live, "live", false, liveWarnings, errors);
          await open(svelte, "svelte", hydrate, svelteWarnings, errors);
          const same = async (expected?: RegExp): Promise<string> => {
            const [native, converted] = await Promise.all([live, svelte].map((page) => page.evaluate(readTable("#products table")) as Promise<string>));
            assert.equal(converted, native);
            if (expected !== undefined) assert.match(converted!, expected);
            return converted!;
          };
          const initial = await same(/^<table><caption>4 columns<\/caption><thead><tr><th scope="col">Name<\/th><th class="numeric" scope="col"><abbr title="Price in US dollars" slot="header">Price<\/abbr><\/th><th scope="col">N<\/th><th scope="col">P<\/th><\/tr><\/thead><tbody><tr><td>Desk lamp<\/td><td><b>Desk lamp:quiet:compact<\/b>49<\/td><td>Desk lamp<\/td><td>49<\/td><\/tr>/);
          // Plain content renders at the first outlet that places it, a <template slot> at each; outlet props
          // convert by the child's slot declaration and take its defaults.
          assert.match(initial, /<tfoot><tr><td><em slot="note">n<\/em>\|<\/td><td><i>t<\/i>\|3<\/td><td>-\|<\/td><td>-\|<\/td><\/tr><tr><td>=\|<\/td><td><i>t<\/i>\|1<\/td><td>=\|<\/td><td>=\|<\/td><\/tr><\/tfoot>/);
          const strays = async (): Promise<void> => assert.equal(await svelte.evaluate(readTable("#strays table")), await live.evaluate(readTable("#strays table")));
          await strays();
          const hosts = async (): Promise<unknown> => {
            const [native, converted] = await Promise.all([live.evaluate(readHosts("live")), svelte.evaluate(readHosts("svelte"))]);
            assert.deepEqual(converted, native);
            return converted;
          };
          // Controllers read the list as state, the columns' roots as the table's default slot, and each
          // column's placed cell content as its own slot; an entry's props are the column's own.
          assert.deepEqual(((await hosts()) as { columns: unknown }[]).map((table) => table.columns), [
            [["name", "Name", 40], [null, null, null], ["name", "N", null], ["price", "P", null]],
            [["name", null, null], [null, null, null], ["name", "W", null], ["id", "A", null], [null, "Bad", null]],
          ]);
          const click = (name: string) => Promise.all([live, svelte].map((page) => page.locator(`#products .${name}`).click()));

          // A consumer $if column joins and leaves the list.
          await click("toggle");
          await same(/^<table><caption>5 columns<\/caption><thead><tr><th scope="col">Id<\/th><th scope="col">Name<\/th>.*<tr><td>1<\/td><td>Desk lamp<\/td>/);
          await click("toggle");
          assert.equal(await same(), initial);

          // A keyed $each column list reorders: its cells move with their entries, keeping their nodes.
          await svelte.evaluate(`window.kept = Array.from(document.querySelectorAll("#products tbody tr:first-child td"))`);
          await click("swap");
          await same(/<th scope="col">P<\/th><th scope="col">N<\/th><\/tr><\/thead><tbody><tr><td>Desk lamp<\/td><td><b>Desk lamp:quiet:compact<\/b>49<\/td><td>49<\/td><td>Desk lamp<\/td>/);
          assert.equal(await svelte.evaluate(`(() => { const now = Array.from(document.querySelectorAll("#products tbody tr:first-child td"));
            return window.kept[0] === now[0] && window.kept[2] === now[3] && window.kept[3] === now[2]; })()`), true);

          // A new row renders a cell per column, its content reading the column's and the table's contexts.
          await click("add");
          await same(/<tr><td>Pen<\/td><td><b>Pen:quiet:compact<\/b>2<\/td><td>2<\/td><td>Pen<\/td><\/tr><\/tbody>/);
          await hosts();

          // When the outlet holding plain content goes, the next outlet takes it over.
          await live.evaluate(`window.HtmlRuntime.getComponentHost(document.querySelector("#products table")).state.notes = false`);
          await svelte.evaluate(`window.tableHosts.find((host) => host.root.closest("#products")).state.notes = false`);
          await Promise.all([live, svelte].map((page) => page.waitForFunction(`document.querySelectorAll("#products tfoot tr").length === 1`)));
          const [native, converted] = await Promise.all([live, svelte].map((page) => page.evaluate(readTable("#products table")) as Promise<string>));
          assert.match(converted!, /<tfoot><tr><td><em slot="note">n<\/em>\|<\/td><td><i>t<\/i>\|1<\/td><td>=\|<\/td><td>=\|<\/td><\/tr><\/tfoot>/);
          assert.equal(converted, native);
          await hosts();

          // Columns under $with and $match follow them.
          await Promise.all([live, svelte].map((page) => page.locator("#strays .flip").click()));
          await Promise.all([live, svelte].map((page) => page.waitForFunction(`document.querySelector("#strays thead").textContent.includes("B")`)));
          await strays();
          assert.deepEqual(((await hosts()) as { columns: unknown }[])[1]!.columns,
            [["name", null, null], [null, null, null], ["price", "W", null], ["price", "B", null], [null, "Bad", null]]);

          for (const pattern of LEFT_OUT) {
            assert.ok(liveWarnings.some((warning) => pattern.test(warning)), `live: ${pattern}`);
            assert.ok(svelteWarnings.some((warning) => pattern.test(warning)), `svelte: ${pattern}`);
          }
          assert.deepEqual(errors, []);
          assert.deepEqual(svelteWarnings.filter((warning) => /hydration/i.test(warning)), []);
        } finally {
          await browser.close();
        }
      });
    }
  }
});
