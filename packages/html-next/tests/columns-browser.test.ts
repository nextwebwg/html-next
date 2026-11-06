import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";

import { build } from "esbuild";
import { chromium, firefox, webkit, type BrowserType, type Page } from "playwright";
import { renderComponents } from "../src/server.js";
import { parseComponent, parseComponentResource } from "../src/source-parser.js";
import { compiledFixtures } from "./hydration-fixtures.js";

// Columns as markup (components#columns-as-markup) in the live runtime. The column template starts
// with its root: a template whose first start tag is <defs> parses in body mode and drops the <th>.
const enabled = process.env.HTMLNEXT_BROWSER_TEST === "1";
const runtimeUrl = new URL("../src/live.ts", import.meta.url);

const column = `<template component="x-column" summary="One column of x-datatable."><th scope="col"><slot name="header">{$header}</slot></th>
  <defs>
    <prop name="field" type="string">The row field a cell shows when no cell content is given.</prop>
    <prop name="header" type="string">The header text.</prop>
    <state name="tone" type="string" value="quiet"></state>
    <slot name="header"></slot>
    <slot name="cell"><prop name="row" type="object" required>The row this cell shows.</prop></slot>
  </defs>
</template>`;

const table = `<template component="x-datatable" summary="A table whose columns are its x-column children.">
  <defs>
    <prop name="rows" type="list(object({ id: number, name: string, price: number }))" required>One entry per table row.</prop>
    <state name="density" type="string" value="compact"></state>
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
  </table>
</template>`;

const badge = `<template component="x-badge" summary="Reads both table contexts.">
  <defs>
    <prop name="text" type="string">Text.</prop>
    <context name="tone" from="x-column"></context>
    <context name="density" from="x-datatable"></context>
  </defs>
  <b>{$text}:{$tone}:{$density}</b>
</template>`;

const products = `<template component="page-products">
  <defs>
    <state name="products" type="list(object({ id: number, name: string, price: number }))"
      value="[{ id: 1, name: 'Desk lamp', price: 49 }, { id: 2, name: 'Notebook', price: 6.5 }]"></state>
    <state name="showId" type="boolean" value="false"></state>
    <state name="extra" type="list(object({ key: string, label: string }))"
      value="[{ key: 'name', label: 'N' }, { key: 'price', label: 'P' }]"></state>
  </defs>
  <main>
    <x-datatable from:rows="$products">
      <x-column $if="$showId" field="id" header="Id"></x-column>
      <x-column field="name" header="Name"></x-column>
      <x-column class="numeric">
        <abbr slot="header" title="Price in US dollars">Price</abbr>
        <template slot="cell"><x-badge from:text="$row.name"></x-badge>{$row.price}</template>
      </x-column>
      <x-column $each="column of $extra" $key="$column.key" from:field="$column.key" from:header="$column.label"></x-column>
    </x-datatable>
  </main>
</template>`;

/** The rendered table without marks, carriers or runtime attributes. */
const readTable = `(() => {
  const read = (node) => {
    if (node.nodeType === 3) return node.data.trim();
    if (node.nodeType !== 1 || node.localName === "template") return "";
    const keep = ["class", "scope", "title", "slot"].filter((name) => node.hasAttribute(name)).map((name) => " " + name + '="' + node.getAttribute(name) + '"');
    return "<" + node.localName + keep.join("") + ">" + Array.from(node.childNodes, read).join("") + "</" + node.localName + ">";
  };
  return read(document.querySelector("table"));
})()`;

const tick = "new Promise((resolve) => setTimeout(resolve, 0))";

describe.skipIf(!enabled)("columns as markup (live runtime)", () => {
  let bundlePath = "";
  let temporaryDirectory = "";

  beforeAll(async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "html-next-columns-"));
    bundlePath = join(temporaryDirectory, "runtime.js");
    await build({ entryPoints: [runtimeUrl.pathname], bundle: true, format: "iife", globalName: "HtmlRuntime", outfile: bundlePath, platform: "browser", target: ["es2022"] });
  });

  afterAll(async () => {
    if (temporaryDirectory !== "") await rm(temporaryDirectory, { recursive: true, force: true });
  });

  const open = async (page: Page): Promise<string[]> => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setContent(`${column}${table}${badge}${products}<page-products></page-products>`);
    await page.addScriptTag({ path: bundlePath });
    await page.evaluate(`window.HtmlRuntime.observeDocument(document)`);
    return errors;
  };
  const pageHost = `window.HtmlRuntime.getComponentHost(document.querySelector("main"))`;

  for (const [engine, browserType] of [["Chromium", chromium], ["Firefox", firefox], ["WebKit", webkit]] as const satisfies ReadonlyArray<readonly [string, BrowserType]>) {
    for (const hydrate of [false, true]) it(`${engine} filters accepted content without as through forwarded fallbacks (${hydrate ? "hydrated" : "fresh"})`, async () => {
      const source = `<template component="x-accepted"><defs><prop name="label" type="string">Label.</prop></defs><b>{$label}</b></template>
        <template component="x-rejected"><defs><prop name="required" type="string" required>Required.</prop></defs><i>Wrong</i></template>
        <template component="x-filter"><defs><slot accepts="x-accepted"></slot></defs><section><slot>List empty</slot></section></template>
        <template component="x-forward"><defs><state name="show" type="boolean" value="true"></state></defs><article><x-filter $if="$show"><slot><x-accepted label="Relay"></x-accepted></slot></x-filter></article></template>
        <template component="x-acceptance-page"><defs><state name="rows" type="list(object({ id: number, good: boolean, label: string }))" from="[]"></state></defs><main><x-forward><template $each="row of $rows" $key="$row.id"><template $match><x-accepted $when="$row.good" from:label="$row.label"></x-accepted><x-rejected $else></x-rejected></template></template></x-forward></main></template>`;
      const definitions = parseComponentResource(source, "accepted-without-list.html").definitions;
      const server = hydrate ? (await renderComponents("<x-acceptance-page></x-acceptance-page>", { definitions })).html : undefined;
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        const errors: string[] = [], warnings: string[] = [];
        page.on("pageerror", error => errors.push(error.message));
        page.on("console", message => { if (message.type() === "warning") warnings.push(message.text()); });
        await page.setContent(server ?? source + "<x-acceptance-page></x-acceptance-page>");
        await page.addScriptTag({ path: bundlePath });
        await page.evaluate(definitions => {
          const api = (window as any).HtmlRuntime;
          if (definitions !== undefined) api.registerComponentDefinitions(JSON.parse(definitions));
          api.observeDocument(document);
        }, hydrate ? JSON.stringify(definitions) : undefined);
        const text = () => page.locator("section").textContent();
        const settle = () => page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        await settle();
        assert.equal(await text(), "Relay");
        const rows = async (value: readonly { id: number; good: boolean; label: string }[]) => {
          await page.evaluate(value => { (window as any).HtmlRuntime.getComponentHost(document.querySelector("main")).state.rows = value; }, value);
          await settle();
        };
        await rows([{ id: 1, good: true, label: "A" }, { id: 2, good: false, label: "Wrong" }]);
        assert.equal(await text(), "A");
        await rows([]);
        assert.equal(await text(), "Relay");
        for (let index = 0; index < 3; index++) {
          await page.evaluate(() => { (window as any).HtmlRuntime.getComponentHost(document.querySelector("article")).state.show = false; });
          await settle();
          assert.equal(await page.locator("section").count(), 0);
          await page.evaluate(() => { (window as any).HtmlRuntime.getComponentHost(document.querySelector("article")).state.show = true; });
          await settle();
          assert.equal(await text(), "Relay");
        }
        await rows([{ id: 3, good: true, label: "B" }]);
        assert.equal(await text(), "B");
        assert.equal(await page.locator("section b").count(), 1);
        assert.ok(warnings.length > 0);
        assert.ok(warnings.every(message => /accepts .*left out/.test(message)), warnings.join("\n"));
        assert.deepEqual(errors, []);
      } finally { await browser.close(); }
    });

    it(`${engine} renders the spec's data table, follows consumer $if and $each, and keeps cells by key`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        const errors = await open(page);
        const row = (cells: string) => `<tr>${cells}</tr>`;
        const badgeCell = (name: string, price: string) => `<td><b>${name}:quiet:compact</b>${price}</td>`;
        const header = (...cells: string[]) => `<thead><tr>${cells.join("")}</tr></thead>`;
        const name = `<th scope="col">Name</th>`;
        const price = `<th class="numeric" scope="col"><abbr title="Price in US dollars" slot="header">Price</abbr></th>`;
        const n = `<th scope="col">N</th>`;
        const p = `<th scope="col">P</th>`;
        const initial = await page.evaluate(readTable);
        assert.equal(initial,
          `<table><caption>4 columns</caption>${header(name, price, n, p)}<tbody>` +
          row(`<td>Desk lamp</td>${badgeCell("Desk lamp", "49")}<td>Desk lamp</td><td>49</td>`) +
          row(`<td>Notebook</td>${badgeCell("Notebook", "6.5")}<td>Notebook</td><td>6.5</td>`) +
          `</tbody></table>`);

        // A consumer $if column joins and leaves the list.
        await page.evaluate(`(async () => { ${pageHost}.state.showId = true; await ${tick}; await ${tick}; })()`);
        const shown = await page.evaluate(readTable) as string;
        assert.match(shown, /^<table><caption>5 columns<\/caption><thead><tr><th scope="col">Id<\/th><th scope="col">Name<\/th>/);
        assert.match(shown, /<tr><td>1<\/td><td>Desk lamp<\/td>/);
        await page.evaluate(`(async () => { ${pageHost}.state.showId = false; await ${tick}; await ${tick}; })()`);
        assert.equal(await page.evaluate(readTable), initial);

        // A keyed $each column list reorders: entries and their cells move, keeping their nodes.
        const moved = await page.evaluate(`(async () => {
          const cells = () => Array.from(document.querySelectorAll("tbody tr:first-child td"));
          const before = cells();
          const table = window.HtmlRuntime.getComponentHost(document.querySelector("table"));
          const entries = Array.from(table.state.columns, (entry) => entry.field ?? null);
          ${pageHost}.state.extra = [{ key: "price", label: "P" }, { key: "name", label: "N" }];
          await ${tick}; await ${tick};
          const after = cells();
          return {
            entries,
            reordered: Array.from(table.state.columns, (entry) => entry.field ?? null),
            same: before[2] === after[3] && before[3] === after[2] && before[0] === after[0],
            slots: table.slots.default.length,
          };
        })()`);
        assert.deepEqual(moved, { entries: ["name", null, "name", "price"], reordered: ["name", null, "price", "name"], same: true, slots: 4 });
        assert.match(await page.evaluate(readTable), /<th scope="col">P<\/th><th scope="col">N<\/th><\/tr><\/thead><tbody><tr><td>Desk lamp<\/td><td><b>Desk lamp:quiet:compact<\/b>49<\/td><td>49<\/td><td>Desk lamp<\/td>/);

        // The column's host.slots.cell lists each rendered cell instance, and a new row renders its cells.
        const cells = await page.evaluate(`(async () => {
          const priceColumn = window.HtmlRuntime.getComponentHost(document.querySelector("th.numeric"));
          const before = priceColumn.slots.cell.length;
          ${pageHost}.state.products = [...${pageHost}.state.products, { id: 3, name: "Pen", price: 2 }];
          await ${tick}; await ${tick};
          return { before, after: priceColumn.slots.cell.length, last: document.querySelector("tbody tr:last-child").textContent.replace(/\\s+/g, "") };
        })()`);
        assert.deepEqual(cells, { before: 2, after: 3, last: "PenPen:quiet:compact22Pen" });
        assert.deepEqual(errors, []);
      } finally {
        await browser.close();
      }
    });

    it(`${engine} hydrates server output, adopting each \`of\` range in place`, async () => {
      const definitions = [column, table, badge, products].map((source) => parseComponent(source));
      const rendered = await renderComponents('<page-products id="subject"></page-products>', { definitions });
      // Each cell's range carries its entry's index in the list; the price column's template stays in its carrier.
      assert.match(rendered.html, /start slot="cell" of="1" scoped=""/);
      assert.match(rendered.html, /start slot="cell" of="0" fallback="" scoped=""/);
      assert.match(rendered.html, /<template carrier="x-column"><template slot="cell">/);
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.setContent(`<div id="server">${rendered.html}</div><div id="client"><page-products id="subject"></page-products></div>`);
        const before = await page.evaluate(`window.kept = Array.from(document.querySelectorAll("#server td, #server td *, #server th")); window.kept.length`);
        await page.addScriptTag({ path: bundlePath });
        const result = await page.evaluate(`(async () => {
          window.HtmlRuntime.registerComponentDefinitions(JSON.parse(${JSON.stringify(JSON.stringify(definitions))}));
          window.HtmlRuntime.observeDocument(document);
          const read = (box) => box.querySelector("table").innerHTML.replace(/<!--[^>]*-->|<\\?[^>]*>/g, "").replace(/ data-[\\w-]+="[^"]*"| component="[^"]*"/g, "").replace(/<template carrier[\\s\\S]*?<\\/template><\\/template>/g, "");
          const server = document.querySelector("#server");
          const client = document.querySelector("#client");
          const adopted = window.kept.every((node) => server.contains(node));
          const initial = [read(server), read(client)];
          for (const box of [server, client]) {
            const host = window.HtmlRuntime.getComponentHost(box.querySelector("main"));
            host.state.products = [...host.state.products, { id: 3, name: "Pen", price: 2 }];
            host.state.showId = true;
          }
          await ${tick}; await ${tick};
          return { adopted, initial, changed: [read(server), read(client)], kept: window.kept.every((node) => server.contains(node)) };
        })()`) as { adopted: boolean; initial: string[]; changed: string[]; kept: boolean };
        assert.ok((before as number) > 10);
        assert.equal(result.adopted, true);
        assert.equal(result.initial[0], result.initial[1]);
        assert.equal(result.changed[0], result.changed[1]);
        assert.match(result.changed[0]!, /Pen:quiet:compact/);
        assert.equal(result.kept, true);
        assert.deepEqual(errors, []);
      } finally {
        await browser.close();
      }
    });

    it(`${engine} places plain slot content once, so no carrier copies it and hydration keeps it`, async () => {
      const definitions = [
        `<template component="x-note"><th><slot name="label"></slot></th><defs><slot name="label"></slot><slot name="detail"></slot></defs></template>`,
        `<template component="x-notes"><defs><slot accepts="x-note" as="notes"></slot></defs><table><thead><tr><template $slot></template></tr></thead>
          <tbody><tr><td $each="note of $notes" $key="$note"><slot of="$note" name="detail">none</slot></td></tr></tbody></table></template>`,
        `<template component="page-notes"><defs><state name="first" type="boolean" value="false"></state></defs>
          <main><x-notes><x-note $if="$first"><i slot="label">First</i></x-note><x-note><i slot="label">Kept</i><b slot="detail">kept</b></x-note><x-note></x-note></x-notes></main></template>`,
      ].map((source) => parseComponent(source));
      const rendered = await renderComponents('<page-notes id="subject"></page-notes>', { definitions });
      assert.equal(rendered.html.match(/>kept</g)?.length, 1);
      assert.match(rendered.html, /start slot="detail" of="0"\?><b slot="detail"[^>]*>kept<\/b>/);
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.setContent(`<div id="server">${rendered.html}</div>`);
        await page.addScriptTag({ path: bundlePath });
        const result = await page.evaluate(`(async () => {
          const kept = document.querySelector("b");
          window.HtmlRuntime.registerComponentDefinitions(JSON.parse(${JSON.stringify(JSON.stringify(definitions))}));
          window.HtmlRuntime.observeDocument(document);
          const cells = () => Array.from(document.querySelectorAll("td"), (cell) => cell.textContent.trim());
          const initial = cells();
          window.HtmlRuntime.getComponentHost(document.querySelector("main")).state.first = true;
          await ${tick}; await ${tick};
          return { initial, changed: cells(), same: document.querySelector("b") === kept && kept.isConnected };
        })()`);
        assert.deepEqual(result, { initial: ["kept", "none"], changed: ["none", "kept", "none"], same: true });
        assert.deepEqual(errors, []);
      } finally {
        await browser.close();
      }
    });

    it(`${engine} moves plain slot content to the next outlet when its outlet goes, before and after hydration`, async () => {
      const definitions = [
        `<template component="x-note"><th>Note</th><defs><slot name="detail"></slot></defs></template>`,
        `<template component="x-notes"><defs><prop name="rows" type="list(number)">Row ids.</prop><slot accepts="x-note" as="notes"></slot></defs><table><thead><tr><template $slot></template></tr></thead>
          <tbody><tr $each="row of $rows" $key="$row"><td $each="note of $notes" $key="$note"><slot of="$note" name="detail">none</slot></td></tr></tbody></table></template>`,
        `<template component="page-notes"><defs><state name="rows" type="list(number)" value="[1, 2, 3]"></state></defs>
          <main><x-notes from:rows="$rows"><x-note><b slot="detail">kept</b></x-note></x-notes></main></template>`,
      ].map((source) => parseComponent(source));
      const rendered = await renderComponents('<page-notes id="subject"></page-notes>', { definitions });
      const browser = await browserType.launch({ headless: true });
      try {
        for (const html of [rendered.html, "<page-notes></page-notes>"]) {
          const page = await browser.newPage();
          const errors: string[] = [];
          page.on("pageerror", (error) => errors.push(error.message));
          await page.setContent(`<div id="server">${html}</div>`);
          await page.addScriptTag({ path: bundlePath });
          const result = await page.evaluate(`(async () => {
            window.HtmlRuntime.registerComponentDefinitions(JSON.parse(${JSON.stringify(JSON.stringify(definitions))}));
            window.HtmlRuntime.observeDocument(document);
            await ${tick};
            const kept = document.querySelector("b");
            const cells = () => Array.from(document.querySelectorAll("td"), (cell) => cell.textContent.trim());
            const initial = cells();
            const state = window.HtmlRuntime.getComponentHost(document.querySelector("main")).state;
            state.rows = [2, 3];
            await ${tick}; await ${tick};
            const dropped = cells();
            state.rows = [3];
            await ${tick}; await ${tick};
            return { initial, dropped, last: cells(), same: document.querySelector("b") === kept && kept.isConnected };
          })()`);
          assert.deepEqual(result, { initial: ["kept", "none", "none"], dropped: ["kept", "none"], last: ["kept"], same: true });
          assert.deepEqual(errors, []);
          await page.close();
        }
      } finally {
        await browser.close();
      }
    });

    it(`${engine} hydrates a column whose only content its table places`, async () => {
      const definitions = [
        `<template component="x-note"><th>Note</th><defs><slot name="detail"></slot></defs></template>`,
        `<template component="x-notes"><defs><slot accepts="x-note" as="notes"></slot></defs><table><thead><tr><template $slot></template></tr></thead>
          <tbody><tr><td $each="note of $notes" $key="$note"><slot of="$note" name="detail">none</slot></td></tr></tbody></table></template>`,
        `<template component="page-notes"><main><x-notes><x-note><b slot="detail">kept</b></x-note></x-notes></main></template>`,
      ].map((source) => parseComponent(source));
      const rendered = await renderComponents('<page-notes id="subject"></page-notes>', { definitions });
      assert.doesNotMatch(rendered.html, /carrier="x-note"/);
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.setContent(`<div id="server">${rendered.html}</div>`);
        await page.addScriptTag({ path: bundlePath });
        const result = await page.evaluate(`(async () => {
          const kept = document.querySelector("b");
          window.HtmlRuntime.registerComponentDefinitions(JSON.parse(${JSON.stringify(JSON.stringify(definitions))}));
          window.HtmlRuntime.observeDocument(document);
          await ${tick};
          const detail = window.HtmlRuntime.getComponentHost(document.querySelector("th")).slots.detail;
          return { detail: detail.length === 1 && detail[0] === kept, same: document.querySelector("b") === kept };
        })()`);
        assert.deepEqual(result, { detail: true, same: true });
        assert.deepEqual(errors, []);
      } finally {
        await browser.close();
      }
    });

    it(`${engine} warns for children a slot does not accept and for unknown or prop-less placements`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        const warnings: string[] = [];
        page.on("console", (message) => { if (message.type() === "warning") warnings.push(message.text()); });
        await page.setContent(`${column}${table}<template component="x-column-preset"><x-column field="name"></x-column></template>` +
          `<x-datatable rows='[{"id":1,"name":"A","price":1}]'><x-column field="name"></x-column><x-colum></x-colum>stray<x-column-preset></x-column-preset>` +
          `<x-column><span slot="cell">plain</span></x-column></x-datatable>`);
        await page.addScriptTag({ path: bundlePath });
        const text = await page.evaluate(`(() => { window.HtmlRuntime.lowerDocument(); return document.querySelector("tbody").textContent.replace(/\\s+/g, ""); })()`);
        // The prop-less span is not placed, so that column shows its fallback for an absent field.
        assert.equal(text, "A");
        const joined = warnings.join("\n");
        assert.match(joined, /`x-datatable`'s default slot accepts `x-column`; this `<x-colum>` is left out\./);
        assert.match(joined, /`x-datatable`'s default slot accepts `x-column`; this text is left out\./);
        assert.match(joined, /`<x-column-preset>` is a preset of `x-column`.*not supported yet/);
        assert.match(joined, /`cell` has props, so its content is a `<template slot="cell">`\./);
      } finally {
        await browser.close();
      }
    });
  }
});

// A table and its columns written directly in a page, rendered by the server and hydrated: by the live
// runtime, and through compiled factories called as a script calls them, with the server's column roots
// as the table's children where the server put them, or moved into the caller's own region first.
describe.skipIf(!enabled)("columns as markup, hydrated from server output", () => {
  let directory = "";
  let runtimePath = "";
  let compiledPath = "";
  const definitions = [column, table].map((source) => parseComponent(source));

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-columns-hydration-"));
    runtimePath = join(directory, "runtime.js");
    compiledPath = join(directory, "compiled.js");
    await build({ entryPoints: [runtimeUrl.pathname], bundle: true, format: "iife", globalName: "HtmlRuntime", outfile: runtimePath, platform: "browser", target: ["es2022"] });
    await writeFile(compiledPath, await compiledFixtures("iife", 'export { serverProjection, slotRegion } from "@nextwebwg/html-next/generated-runtime"; export { getComponentHost } from "@nextwebwg/html-next/runtime";', definitions));
  });

  afterAll(async () => {
    if (directory !== "") await rm(directory, { recursive: true, force: true });
  });

  const markup = `<x-datatable id="subject" rows="[{ id: 1, name: 'Desk lamp', price: 49 }, { id: 2, name: 'Notebook', price: 6.5 }]">` +
    `<x-column field="name" header="Name"></x-column><x-column field="price"><abbr slot="header" title="Price in US dollars">Price</abbr></x-column></x-datatable>`;

  /** Each mode hydrates `#subject`; `factories` are the compiled ones. */
  const modes = {
    live: `window.HtmlRuntime.registerComponentDefinitions(definitions); window.HtmlRuntime.lowerDocument();`,
    // A script adopts each server column root, then the table with those roots as its children.
    "compiled, in place": `const columns = Array.from(root.querySelectorAll("th"));
      for (const th of columns) factories["x-column"]({}, undefined, th);
      factories["x-datatable"]({ children: columns }, undefined, root);`,
    // A script takes the server's projections, moves each into a region of its own, adopts the column
    // roots it holds, and gives the table and columns those regions, as a framework renderer does.
    "compiled, regions": `const region = (nodes, slot) => {
        const start = document.createComment("html-next:start"), end = document.createComment("html-next:end");
        document.createDocumentFragment().append(start, ...nodes, end);
        compiled.slotRegion(start, end, slot);
        return [start, ...nodes, end];
      };
      const [children] = compiled.serverProjection(root, "x-datatable");
      for (const th of children.filter((node) => node.nodeType === 1)) {
        const [, slots] = compiled.serverProjection(th, "x-column");
        factories["x-column"]({ slots: Object.fromEntries(Object.entries(slots).map(([name, nodes]) => [name, region(nodes, name)])) }, undefined, th);
      }
      factories["x-datatable"]({ children: region(children, "") }, undefined, root);`,
  } as const;

  for (const [engine, browserType] of [["Chromium", chromium], ["Firefox", firefox], ["WebKit", webkit]] as const satisfies ReadonlyArray<readonly [string, BrowserType]>) {
    for (const [mode, hydrate] of Object.entries(modes)) {
      it(`${engine} keeps the server's header and body cells, hydrated ${mode}`, async () => {
        const rendered = await renderComponents(markup, { definitions });
        const browser = await browserType.launch({ headless: true });
        try {
          const page = await browser.newPage();
          const errors: string[] = [];
          page.on("pageerror", (error) => errors.push(error.message));
          await page.setContent(rendered.html);
          await page.addScriptTag({ path: runtimePath });
          if (mode !== "live") await page.addScriptTag({ path: compiledPath });
          const result = await page.evaluate(`(async () => {
            const definitions = JSON.parse(${JSON.stringify(JSON.stringify(definitions))});
            const compiled = window.HtmlCompiled, factories = compiled?.factories;
            const root = document.querySelector("#subject");
            const read = () => ({
              header: Array.from(root.querySelectorAll("thead th"), (cell) => cell.textContent.trim()),
              rows: Array.from(root.querySelectorAll("tbody tr"), (row) => Array.from(row.cells, (cell) => cell.textContent.trim())),
            });
            const server = read();
            const kept = Array.from(root.querySelectorAll("th, td, abbr"));
            ${hydrate}
            await ${tick};
            return { server, hydrated: read(), kept: kept.every((node) => root.contains(node)), columns: (compiled ?? window.HtmlRuntime).getComponentHost(root)?.state.columns?.length };
          })()`);
          const expected = { header: ["Name", "Price"], rows: [["Desk lamp", "49"], ["Notebook", "6.5"]] };
          assert.deepEqual(result, { server: expected, hydrated: expected, kept: true, columns: 2 });
          assert.deepEqual(errors, []);
        } finally {
          await browser.close();
        }
      });
    }
  }
});
