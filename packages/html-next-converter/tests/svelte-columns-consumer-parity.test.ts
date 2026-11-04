import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, it } from "vitest";

import { build } from "esbuild";
import { chromium, webkit, type BrowserType, type Page } from "playwright";

import { convertComponents } from "../src/index.js";
import { sveltePlugin } from "./helpers/svelte.js";

/**
 * Columns as markup (https://nextwebwg.org/declarative-components/components#slot-accepts-as) in
 * converted Svelte, given by a consumer written in Svelte: columns written directly, under `{#if}` and a
 * keyed `{#each}`, a column's own header snippet, cell, note and total snippets with slot props, field
 * fallback, a reactive column prop, and context read from cell content (column, then table). The page
 * the live runtime renders is the same page in HTML; a Svelte snippet renders at each outlet, as a
 * `<template slot>` does. Columns join the list as the table's header outlet renders them, so the body
 * reads the whole list on the server and through hydration, and the caption before the outlet reads it
 * once hydration has run.
 */
const enabled = process.env.HTMLNEXT_TARGET_TEST === "1";
const nodeModules = fileURLToPath(new URL("../node_modules", import.meta.url));

const source = `<template component="x-column" status="early" summary="One column of x-datatable." controller="./column.js"><th scope="col"><slot name="header">{$header}</slot></th>
  <defs>
    <prop name="field" type="string">The row field a cell shows when no cell content is given.</prop>
    <prop name="header" type="string">The header text.</prop>
    <prop name="width" type="number">The column's width.</prop>
    <state name="tone" type="string" value="quiet"></state>
    <slot name="header"></slot>
    <slot name="cell"><prop name="row" type="object" required>The row this cell shows.</prop></slot>
    <slot name="note"></slot>
    <slot name="total"><prop name="size" type="number" default="1">The size.</prop></slot>
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
    <caption>{$columns.length} listed</caption>
    <thead><tr><template $slot></template></tr></thead>
    <tbody>
      <tr $each="row of $rows" $key="$row.id">
        <td $each="column of $columns" $key="$column">
          <slot of="$column" name="cell" from:row="$row">{$row[$column.field]}</slot>
        </td>
      </tr>
    </tbody>
    <tfoot>
      <tr $if="$notes"><td $each="column of $columns" $key="$column"><slot of="$column" name="note">-</slot>|<slot of="$column" name="total" size="3"></slot></td></tr>
      <tr><td>{$columns.length} columns</td></tr>
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
<template component="x-column-preset" status="early" summary="A preset of x-column."><x-column field="price" header="Preset"></x-column></template>
<template component="page-products" status="early" summary="Products, as the Svelte consumer writes them.">
  <defs>
    <state name="products" type="list(object({ id: number, name: string, price: number }))"
      value="[{ id: 1, name: 'Desk lamp', price: 49 }, { id: 2, name: 'Notebook', price: 6.5 }]"></state>
    <state name="showId" type="boolean" value="false"></state>
    <state name="nameField" type="string" value="name"></state>
    <state name="extra" type="list(object({ key: string, label: string }))"
      value="[{ key: 'name', label: 'N' }, { key: 'price', label: 'P' }]"></state>
    <handler name="toggle"><set name="showId" expr:value="not $showId"></set></handler>
    <handler name="swap"><set name="extra" expr:value="[{ key: 'price', label: 'P' }, { key: 'name', label: 'N' }]"></set></handler>
    <handler name="add"><set name="products" expr:value="[{ id: 1, name: 'Desk lamp', price: 49 }, { id: 2, name: 'Notebook', price: 6.5 }, { id: 3, name: 'Pen', price: 2 }]"></set></handler>
    <handler name="refield"><set name="nameField" value="price"></set></handler>
  </defs>
  <main id="products">
    <button type="button" class="toggle" on:click="toggle">Id</button>
    <button type="button" class="swap" on:click="swap">Swap</button>
    <button type="button" class="add" on:click="add">Add</button>
    <button type="button" class="refield" on:click="refield">Refield</button>
    <x-datatable from:rows="$products">
      <x-column $if="$showId" field="id" header="Id"></x-column>
      <x-column from:field="$nameField" header="Name" width="40"></x-column>
      <x-column class="numeric">
        <abbr slot="header" title="Price in US dollars">Price</abbr>
        <template slot="cell"><x-badge from:text="$row.name"></x-badge>{$row.price}</template>
        <template slot="note"><i>t</i></template>
        <template slot="total">{$size}</template>
      </x-column>
      <x-column $each="column of $extra" $key="$column.key" from:field="$column.key" from:header="$column.label"></x-column>
    </x-datatable>
  </main>
</template>`;

/** The same page, written in Svelte against the converted components. */
const consumer = (table: string, column: string, badge: string): string => `<script lang="ts">
  import XDatatable from "./${table}";
  import XColumn from "./${column}";
  import XBadge from "./${badge}";
  let products = $state([{ id: 1, name: "Desk lamp", price: 49 }, { id: 2, name: "Notebook", price: 6.5 }]);
  let showId = $state(false);
  let nameField = $state("name");
  let extra = $state([{ key: "name", label: "N" }, { key: "price", label: "P" }]);
</script>

{#snippet header()}<abbr title="Price in US dollars">Price</abbr>{/snippet}
{#snippet cell({ row }: { row: { name: string; price: number } })}<XBadge text={row.name} />{row.price}{/snippet}
{#snippet note()}<i>t</i>{/snippet}
{#snippet total({ size }: { size: number })}{size}{/snippet}

<main id="products">
  <button type="button" class="toggle" onclick={() => { showId = !showId; }}>Id</button>
  <button type="button" class="swap" onclick={() => { extra = [{ key: "price", label: "P" }, { key: "name", label: "N" }]; }}>Swap</button>
  <button type="button" class="add" onclick={() => { products = [...products, { id: 3, name: "Pen", price: 2 }]; }}>Add</button>
  <button type="button" class="refield" onclick={() => { nameField = "price"; }}>Refield</button>
  <XDatatable rows={products}>
    {#if showId}<XColumn field="id" header="Id" />{/if}
    <XColumn field={nameField} header="Name" width={40} />
    <XColumn class="numeric" slots={{ header, cell, note, total }} />
    {#each extra as column (column.key)}<XColumn field={column.key} header={column.label} />{/each}
  </XDatatable>
</main>
`;
/** Columns inside the consumer's own component and a preset. */
const wrapped = (table: string, preset: string): string => `<script lang="ts">
  import XDatatable from "./${table}";
  import XColumnPreset from "./${preset}";
  import Pair from "./Pair.svelte";
</script>

<XDatatable rows={[{ id: 1, name: "Desk lamp", price: 49 }]}><Pair /><XColumnPreset /></XDatatable>
`;
const pair = (column: string): string => `<script lang="ts">
  import XColumn from "./${column}";
</script>

<XColumn field="name" header="Name" /><XColumn field="id" header="Id" />
`;
const columnController = `export default function initialize(host) { (window.columnHosts ??= []).push(host); }`;
const tableController = `export default function initialize(host) { (window.tableHosts ??= []).push(host); }`;

/** The table's markup without marks, runtime attributes or carriers. */
const readTable = `(() => {
  const read = (node) => {
    if (node.nodeType === 3) return node.data.trim();
    if (node.nodeType !== 1 || node.localName === "template") return "";
    const keep = ["class", "scope", "title"].filter((name) => node.hasAttribute(name)).map((name) => " " + name + '="' + node.getAttribute(name) + '"');
    return "<" + node.localName + keep.join("") + ">" + Array.from(node.childNodes, read).join("") + "</" + node.localName + ">";
  };
  return read(document.querySelector("#products table"));
})()`;

/** What the table's controller reads: its list's entries and the columns' roots as its default slot. */
const readHost = (target: "live" | "svelte"): string => `(() => {
  const table = ${target === "live" ? `window.HtmlRuntime.getComponentHost(document.querySelector("#products table"))`
    : `window.tableHosts.find((candidate) => candidate.root === document.querySelector("#products table"))`};
  return { columns: Array.from(table.state.columns, (entry) => [entry.field, entry.header, entry.width]),
    slots: table.slots.default.map((element) => element.textContent) };
})()`;

describe.skipIf(!enabled)("Svelte columns as markup from a Svelte consumer", () => {
  let directory = "";
  let liveBundle = "";
  let svelteBundle = "";
  let serverMarkup = "";
  let wrappedMarkup = "";
  const serverWarnings: string[] = [];

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-svelte-columns-consumer-"));
    await symlink(nodeModules, join(directory, "node_modules"), "dir");
    await mkdir(join(directory, "components"));
    await writeFile(join(directory, "components/table.html"), source);
    await writeFile(join(directory, "components/column.js"), columnController);
    await writeFile(join(directory, "components/table.js"), tableController);
    const out = join(directory, "svelte");
    const manifest = await convertComponents({ mode: "application", target: "svelte", root: directory, outDirectory: out, entries: ["components/**"] });
    const artifact = (tag: string): string => manifest.components.find((component) => component.tag === tag)!.artifact;
    await writeFile(join(out, "Products.svelte"), consumer(artifact("x-datatable"), artifact("x-column"), artifact("x-badge")));
    await writeFile(join(out, "Wrapped.svelte"), wrapped(artifact("x-datatable"), artifact("x-column-preset")));
    await writeFile(join(out, "Pair.svelte"), pair(artifact("x-column")));
    await writeFile(join(out, "mount.ts"), `import { mount, hydrate } from "svelte"; import App from "./Products.svelte";
const target = document.querySelector("#mount")!;
if (target.hasChildNodes()) hydrate(App, { target }); else mount(App, { target });`);
    svelteBundle = join(directory, "svelte.js");
    await build({ entryPoints: [join(out, "mount.ts")], outfile: svelteBundle, bundle: true, format: "iife", platform: "browser",
      target: ["es2022"], loader: { ".css": "empty" }, plugins: [sveltePlugin("client")] });
    await writeFile(join(out, "server.ts"), `import { render } from "svelte/server"; import App from "./Products.svelte"; import Wrapped from "./Wrapped.svelte";
export const html = () => render(App).body;
export const wrapped = () => render(Wrapped).body;`);
    const serverBundle = join(directory, "server.mjs");
    await build({ entryPoints: [join(out, "server.ts")], outfile: serverBundle, bundle: true, format: "esm", platform: "node",
      packages: "external", loader: { ".css": "empty" }, plugins: [sveltePlugin("server")] });
    const warn = console.warn;
    console.warn = (message: unknown) => { serverWarnings.push(String(message)); };
    try {
      const server = await import(pathToFileURL(serverBundle).href) as { html: () => string; wrapped: () => string };
      serverMarkup = server.html();
      wrappedMarkup = server.wrapped();
    } finally { console.warn = warn; }
    liveBundle = join(directory, "live.js");
    await build({ entryPoints: [fileURLToPath(new URL("../../html-next/src/live.ts", import.meta.url))], outfile: liveBundle,
      bundle: true, format: "iife", globalName: "HtmlRuntime", platform: "browser", target: ["es2022"] });
  }, 180_000);

  afterAll(async () => { if (directory !== "") await rm(directory, { recursive: true, force: true }); });

  it("server rendering lists every column the header outlet renders before the body reads them", () => {
    assert.match(serverMarkup, /<caption>0 listed<\/caption>/);
    assert.match(serverMarkup, /<td>4 columns<\/td>/);
    assert.match(serverMarkup, /<b[^>]*>Desk lamp:quiet:compact<\/b>(<!---->)?49/);
    assert.match(serverMarkup, />Notebook<!--]-->/);
    assert.deepEqual(serverWarnings, []);
  });

  it("lists an accepted child inside the consumer's own component or a preset", () => {
    assert.match(wrappedMarkup, /<td>3 columns<\/td>/);
    assert.deepEqual([...wrappedMarkup.matchAll(/<tbody>.*?<\/tbody>/gs)].flatMap(([body]) => [...body.matchAll(/<td>(?:<!--.*?-->)*([^<]+)/g)].map((cell) => cell[1])), ["Desk lamp", "1", "49"]);
  });

  const open = async (page: Page, target: "live" | "svelte", hydrate: boolean, warnings: string[], errors: string[]): Promise<void> => {
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "warning") warnings.push(message.text());
      if (message.type() === "error") errors.push(message.text());
    });
    if (target === "live") {
      await page.setContent(`${source.replaceAll(/ controller="[^"]*"/g, "")}<div id="mount"><page-products></page-products></div>`);
      await page.addScriptTag({ path: liveBundle });
      await page.evaluate(`window.HtmlRuntime.observeDocument(document)`);
    } else {
      await page.setContent(`<div id="mount">${hydrate ? serverMarkup : ""}</div>`);
      await page.evaluate(`window.served = Array.from(document.querySelectorAll("#mount th, #mount td, #mount td *"))`);
      await page.addScriptTag({ path: svelteBundle });
      // Hydration adopts the server's cells, the cell content among them.
      if (hydrate) assert.deepEqual(await page.evaluate(`({ served: window.served.length > 10, lost: window.served.filter((node) => !node.isConnected).length })`), { served: true, lost: 0 });
    }
    await page.locator("#products tfoot").waitFor();
    if (target === "svelte") await page.waitForFunction(`window.tableHosts?.length === 1 && window.columnHosts?.length >= 4`);
  };

  for (const [engine, browserType] of [["Chromium", chromium], ["WebKit", webkit]] as const satisfies ReadonlyArray<readonly [string, BrowserType]>) {
    for (const hydrate of [false, true]) {
      it(`${engine} ${hydrate ? "hydrates" : "mounts"} the table as live renders it, following {#if}, keyed {#each}, props and context`, async () => {
        const browser = await browserType.launch({ headless: true });
        try {
          const live = await browser.newPage();
          const svelte = await browser.newPage();
          const liveWarnings: string[] = [];
          const svelteWarnings: string[] = [];
          const errors: string[] = [];
          await open(live, "live", false, liveWarnings, errors);
          await open(svelte, "svelte", hydrate, svelteWarnings, errors);
          const same = async (expected?: RegExp): Promise<string> => {
            // A change settles after a flush and, for a moved column, its MutationObserver record.
            await svelte.evaluate(`new Promise((resolve) => setTimeout(resolve))`);
            const [native, converted] = await Promise.all([live, svelte].map((page) => page.evaluate(readTable) as Promise<string>));
            assert.equal(converted, native);
            if (expected !== undefined) assert.match(converted!, expected);
            const [nativeHost, convertedHost] = await Promise.all([live.evaluate(readHost("live")), svelte.evaluate(readHost("svelte"))]);
            assert.deepEqual(convertedHost, nativeHost);
            return converted!;
          };
          const initial = await same(/^<table><caption>4 listed<\/caption><thead><tr><th scope="col">Name<\/th><th class="numeric" scope="col"><abbr title="Price in US dollars">Price<\/abbr><\/th><th scope="col">N<\/th><th scope="col">P<\/th><\/tr><\/thead><tbody><tr><td>Desk lamp<\/td><td><b>Desk lamp:quiet:compact<\/b>49<\/td><td>Desk lamp<\/td><td>49<\/td><\/tr>/);
          // A snippet renders at each outlet, taking the outlet's props and the slot's defaults.
          assert.match(initial, /<tfoot><tr><td>-\|<\/td><td><i>t<\/i>\|3<\/td><td>-\|<\/td><td>-\|<\/td><\/tr><tr><td>4 columns<\/td><\/tr><\/tfoot>/);
          assert.deepEqual(await svelte.evaluate(readHost("svelte")), { columns: [["name", "Name", 40], [null, null, null], ["name", "N", null], ["price", "P", null]], slots: ["Name", "Price", "N", "P"] });
          const click = (name: string) => Promise.all([live, svelte].map((page) => page.locator(`#products .${name}`).click()));

          // An {#if} column joins the list at its place in the content, and leaves it.
          await click("toggle");
          await same(/^<table><caption>5 listed<\/caption><thead><tr><th scope="col">Id<\/th><th scope="col">Name<\/th>.*<tr><td>1<\/td><td>Desk lamp<\/td>/);
          await click("toggle");
          assert.equal(await same(), initial);

          // A keyed {#each} reorders its columns: their cells move with their entries, keeping their nodes.
          await svelte.evaluate(`window.kept = Array.from(document.querySelectorAll("#products tbody tr:first-child td"))`);
          await click("swap");
          await same(/<th scope="col">P<\/th><th scope="col">N<\/th><\/tr><\/thead><tbody><tr><td>Desk lamp<\/td><td><b>Desk lamp:quiet:compact<\/b>49<\/td><td>49<\/td><td>Desk lamp<\/td>/);
          assert.equal(await svelte.evaluate(`(() => { const now = Array.from(document.querySelectorAll("#products tbody tr:first-child td"));
            return window.kept[0] === now[0] && window.kept[2] === now[3] && window.kept[3] === now[2]; })()`), true);

          // A new row renders a cell per column; a column's changed prop changes its entry and its cells.
          await click("add");
          await same(/<tr><td>Pen<\/td><td><b>Pen:quiet:compact<\/b>2<\/td><td>2<\/td><td>Pen<\/td><\/tr><\/tbody>/);
          await click("refield");
          await same(/<tbody><tr><td>49<\/td><td><b>Desk lamp:quiet:compact<\/b>49<\/td>/);

          // A removed outlet takes its snippets with it; the remaining outlets keep theirs.
          await live.evaluate(`window.HtmlRuntime.getComponentHost(document.querySelector("#products table")).state.notes = false`);
          await svelte.evaluate(`window.tableHosts[0].state.notes = false`);
          await Promise.all([live, svelte].map((page) => page.waitForFunction(`document.querySelectorAll("#products tfoot tr").length === 1`)));
          await same();

          assert.deepEqual(errors, []);
          assert.deepEqual(svelteWarnings, []);
        } finally {
          await browser.close();
        }
      });
    }
  }
});
