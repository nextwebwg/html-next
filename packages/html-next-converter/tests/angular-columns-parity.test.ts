import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { cp, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, it } from "vitest";

import { build } from "esbuild";
import { chromium, firefox, webkit, type Browser, type BrowserType, type Page } from "playwright";

import { convertComponents } from "../src/index.js";

/**
 * Columns as markup (https://nextwebwg.org/declarative-components/components#columns-as-markup) in
 * converted Angular: a table reads its accepted `x-column` children as `$columns`, and each cell
 * places its column's `cell` slot with `<slot of>`. Rendered in the browser and on the server with
 * hydration, and compared with the live runtime for the same source.
 */
const enabled = process.env.HTMLNEXT_TARGET_TEST === "1";
const nodeModules = fileURLToPath(new URL("../node_modules", import.meta.url));
const livePath = fileURLToPath(new URL("../../html-next/src/live.ts", import.meta.url));

// A table-part root comes before its <defs>, so the HTML parser keeps the <th>.
const column = `<template component="x-column" summary="One column."><th scope="col"><slot name="header">{$header}</slot></th><defs>
  <prop name="field" type="string">The row field a cell shows when no cell content is given.</prop>
  <prop name="header" type="string">The header text.</prop>
  <state name="tone" type="string" value="quiet"></state>
  <slot name="header"></slot><slot name="note"></slot>
  <slot name="cell"><prop name="row" type="object" required>The row this cell shows.</prop><prop name="width" type="number">The width.</prop>
    <prop name="label" type="string" default="none">A label.</prop></slot>
  <slot name="sum"><prop name="total" type="number" required>The total.</prop><prop name="unit" type="string" default="USD">The unit.</prop></slot></defs></template>`;
const table = `<link rel="component" href="./column.html">
<template component="x-datatable" controller="./table.js" summary="A table whose columns are its x-column children."><defs>
  <prop name="rows" type="list(object({ id: number, name: string, price: number }))" required>One entry per table row.</prop>
  <state name="density" type="string" value="compact"></state>
  <slot accepts="x-column" as="columns"></slot></defs>
  <table><caption>{$columns.length} columns</caption><thead><tr><template $slot></template></tr></thead>
  <tbody><tr $each="row of $rows" $key="$row.id"><td $each="column of $columns" $key="$column"><slot of="$column" name="cell" from:row="$row" width="3"
    from:label="$row.id = 1 ? $row.name : ($row.id = 2 ? null : $row.id)">{$row[$column.field]}</slot></td></tr></tbody>
  <tfoot><tr $each="row of $rows" $key="$row.id"><td $each="column of $columns" $key="$column"><slot of="$column" name="note">-</slot><slot of="$column" name="sum" extra="x">.</slot></td></tr></tfoot></table></template>`;
const badge = `<template component="x-badge" summary="Reads both table contexts."><defs><prop name="text" type="string">Text.</prop>
  <context name="tone" from="x-column"></context><context name="density" from="x-datatable"></context></defs>
  <b>{$text}:{$tone}:{$density}</b></template>`;
const products = `<link rel="component" href="./column.html"><link rel="component" href="./table.html"><link rel="component" href="./badge.html">
<template component="page-products"><defs>
  <state name="products" type="list(object({ id: number, name: string, price: number }))"
    value="[{ id: 1, name: 'Desk lamp', price: 49 }, { id: 2, name: 'Notebook', price: 6.5 }]"></state>
  <state name="showId" type="boolean" value="false"></state>
  <state name="extra" type="list(object({ key: string, label: string }))" value="[{ key: 'name', label: 'N' }, { key: 'price', label: 'P' }]"></state>
  <handler name="toggle"><set name="showId" expr:value="not $showId"></set></handler>
  <handler name="swap"><set name="extra" expr:value="[{ key: 'price', label: 'P' }, { key: 'name', label: 'N' }]"></set></handler>
  <handler name="add"><set name="products" expr:value="[{ id: 1, name: 'Desk lamp', price: 49 }, { id: 2, name: 'Notebook', price: 6.5 }, { id: 3, name: 'Pen', price: 2 }]"></set></handler>
  <handler name="drop"><set name="products" expr:value="[{ id: 2, name: 'Notebook', price: 6.5 }, { id: 3, name: 'Pen', price: 2 }]"></set></handler>
</defs><main><button type="button" class="toggle" on:click="toggle">Id</button><button type="button" class="swap" on:click="swap">Swap</button>
  <button type="button" class="add" on:click="add">Add</button><button type="button" class="drop" on:click="drop">Drop</button><x-datatable from:rows="$products">
    <x-column $if="$showId" field="id" header="Id"></x-column>
    <x-column field="name" header="Name"><i slot="note">kept</i></x-column>
    <x-column class="numeric"><abbr slot="header" title="Price in US dollars">Price</abbr>
      <template slot="cell"><x-badge from:text="$row.name"></x-badge>{$row.price}|{$width + 1}|{$label}</template>
      <template slot="sum"><em>{$unit}</em></template></x-column>
    <template $match><x-column $when="$showId" field="id" header="M"></x-column>
      <x-column $else header="Q"><template slot="cell"><x-badge from:text="$label"></x-badge></template></x-column></template>
    <template $if="not $showId"><x-column field="price" header="W"></x-column></template>
    <x-column $each="column of $extra" $key="$column.key" from:field="$column.key" from:header="$column.label"></x-column>
  </x-datatable></main></template>`;
// Children the default slot does not accept, a preset of an accepted component, and plain content for a slot with props.
const warnings = `<link rel="component" href="./column.html"><link rel="component" href="./table.html">
<template component="x-column-preset"><x-column field="name"></x-column></template>
<template component="page-warnings"><section><x-datatable rows='[{"id":1,"name":"A","price":1}]'><x-column field="name"></x-column><x-colum></x-colum>stray<x-column-preset></x-column-preset>
  <x-column><span slot="cell">plain</span></x-column></x-datatable></section></template>`;
// The controller reads the entries through host.state.
const controller = `export default function (host) { host.effect(() => { host.root.dataset.columns = Array.from(host.state.columns, (entry) => entry.header ?? entry.field ?? "-").join(); }); }`;
const files: Readonly<Record<string, string>> = { "table.js": controller, "column.html": column, "table.html": table, "badge.html": badge, "products.html": products, "warnings.html": warnings };
const WARNED = [
  /`x-datatable`'s default slot accepts `x-column`; this `<x-colum>` is left out\./,
  /`x-datatable`'s default slot accepts `x-column`; this text is left out\./,
  /`<x-column-preset>` is a preset of `x-column`.*not supported yet/,
  /`cell` has props, so its content is a `<template slot="cell">`\./,
  /<slot of name="sum"> gives prop `extra`, which `x-column`'s slot `sum` does not declare\./,
  /<slot of name="sum"> must give prop `total`, which `x-column`'s slot `sum` declares as required\./,
  /Slot `cell` prop `label` does not satisfy its declared type `string`\./,
];

/** The rendered table without marks, carriers or framework attributes. */
const READ = `(() => {
  const read = (node) => {
    if (node.nodeType === 3) return node.data.trim();
    if (node.nodeType !== 1 || node.localName === "template") return "";
    const keep = ["class", "scope", "title", "slot", "data-columns"].filter((name) => node.hasAttribute(name)).map((name) => " " + name + '="' + node.getAttribute(name) + '"');
    return "<" + node.localName + keep.join("") + ">" + Array.from(node.childNodes, read).join("") + "</" + node.localName + ">";
  };
  const table = document.querySelector("table");
  return table === null ? document.body.innerHTML : read(table);
})()`;
/** The second table's body text, where the warned children are left out. */
const LEFT_OUT = `document.querySelectorAll("table")[1]?.querySelector("tbody")?.textContent.replace(/\\s+/g, "") ?? null`;

const frames = (page: Page): Promise<void> => page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));

describe.skipIf(!enabled)("columns as markup in converted Angular", () => {
  let directory = "";
  let liveBundle = "";
  let angularBundle = "";
  let server = "";

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-angular-columns-"));
    await symlink(nodeModules, join(directory, "node_modules"), "dir");
    await writeFile(join(directory, "package.json"), '{"type":"module"}');
    for (const [name, source] of Object.entries(files)) await writeFile(join(directory, name), source);
    liveBundle = join(directory, "live.js");
    await build({ entryPoints: [livePath], outfile: liveBundle, bundle: true, format: "iife", globalName: "HtmlRuntime", platform: "browser", target: ["es2022"] });

    const out = join(directory, "out");
    const manifest = await convertComponents({ mode: "application", target: "angular", root: directory, outDirectory: out, entries: ["products.html", "warnings.html"] });
    const artifact = (tag: string): string => `./out/${manifest.components.find((entry) => entry.tag === tag)!.artifact.replace(/\.ts$/, "")}`;
    const app = join(directory, "app.ts");
    await writeFile(app, `import { Component } from "@angular/core";
import PageProducts from "${artifact("page-products")}";
import PageWarnings from "${artifact("page-warnings")}";
@Component({ selector: "app-root", standalone: true, imports: [PageProducts, PageWarnings], template: '<main page-products></main><section page-warnings></section>' }) export class App {}`);
    const config = join(directory, "tsconfig.json");
    await writeFile(config, JSON.stringify({ compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", strict: true,
      skipLibCheck: true, experimentalDecorators: true, rewriteRelativeImportExtensions: true, rootDir: directory, outDir: join(directory, "compiled"), types: [] },
      angularCompilerOptions: { strictTemplates: true }, files: [app] }));
    const ngc = join(dirname(createRequire(import.meta.url).resolve("@angular/compiler-cli/package.json")), "bundles/src/bin/ngc.js");
    try { await promisify(execFile)(process.execPath, [ngc, "-p", config], { cwd: directory, maxBuffer: 4 * 1024 * 1024 }); }
    catch (error) { const { stdout = "", stderr = "" } = error as { stdout?: string; stderr?: string }; assert.fail(`${stdout}${stderr}` || String(error)); }
    // The controller module is JavaScript beside its declarations, so ngc leaves it where the converter wrote it.
    await cp(join(out, "angular/modules"), join(directory, "compiled/out/angular/modules"), { recursive: true });
    const compiled = join(directory, "compiled/app.js");

    const browserEntry = join(directory, "browser.ts");
    await writeFile(browserEntry, `import "@angular/compiler";
import { bootstrapApplication, provideClientHydration } from "@angular/platform-browser";
import { App } from ${JSON.stringify(compiled)};
bootstrapApplication(App, { providers: document.querySelector("app-root")?.hasAttribute("ngh") ? [provideClientHydration()] : [] }).then(() => { document.body.dataset.ready = "true"; });`);
    angularBundle = join(directory, "angular.js");
    await build({ entryPoints: [browserEntry], outfile: angularBundle, bundle: true, format: "iife", platform: "browser", target: ["es2022"], loader: { ".css": "empty" }, nodePaths: [nodeModules] });
    const serverEntry = join(directory, "server.ts");
    await writeFile(serverEntry, `import "@angular/compiler";
import { renderApplication, provideServerRendering } from "@angular/platform-server";
import { bootstrapApplication, provideClientHydration } from "@angular/platform-browser";
import { App } from ${JSON.stringify(compiled)};
export const render = () => renderApplication(context => bootstrapApplication(App, { providers: [provideServerRendering(), provideClientHydration()] }, context),
  { document: '<html><head><base href="http://localhost/"></head><body><app-root></app-root></body></html>', url: "http://localhost/", allowedHosts: ["localhost"] });`);
    const serverBundle = join(directory, "server.mjs");
    await build({ entryPoints: [serverEntry], outfile: serverBundle, bundle: true, format: "esm", platform: "node", packages: "external", loader: { ".css": "empty" } });
    server = await (await import(pathToFileURL(serverBundle).href) as { render(): Promise<string> }).render();
  }, 240_000);

  afterAll(async () => { if (directory !== "" && process.env.HTMLNEXT_KEEP !== "1") await rm(directory, { recursive: true, force: true }); });

  for (const [engine, browserType] of [["Chromium", chromium], ["Firefox", firefox], ["WebKit", webkit]] as const satisfies ReadonlyArray<readonly [string, BrowserType]>) {
    describe(engine, () => {
      let browser: Browser;
      beforeAll(async () => { browser = await browserType.launch({ headless: true }); });
      afterAll(async () => { await browser?.close(); });

      /** Each step's table, the first row's cells kept across the keyed reorder, and the warnings, as a page shows them. */
      const run = async (page: Page, warned: string[], prepare = ""): Promise<unknown> => {
        const read = async (): Promise<unknown> => { await page.evaluate(prepare); return page.evaluate(READ); };
        const steps: unknown[] = [await read()];
        const click = async (name: string): Promise<void> => { await page.locator(`button.${name}`).click(); await frames(page); steps.push(await read()); };
        await click("toggle");
        await click("toggle");
        await page.evaluate(`window.cells = Array.from(document.querySelectorAll("tbody tr:first-child td"))`);
        await click("swap");
        const kept = await page.evaluate(`(() => { const after = Array.from(document.querySelectorAll("tbody tr:first-child td")); return window.cells[0] === after[0] && window.cells[4] === after[5] && window.cells[5] === after[4]; })()`);
        await click("add");
        // The foot row holding the plain note goes, and the next row's outlet takes the note from its fallback.
        await click("drop");
        return { steps, kept, leftOut: await page.evaluate(LEFT_OUT), warned: WARNED.map((pattern) => warned.some((text) => pattern.test(text))) };
      };
      const open = async (setup: (page: Page) => Promise<void>): Promise<{ page: Page; errors: string[]; warned: string[] }> => {
        const page = await browser.newPage();
        const errors: string[] = [];
        const warned: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        page.on("console", (message) => { if (message.type() === "warning") warned.push(message.text()); else if (message.type() === "error") errors.push(message.text()); });
        try { await setup(page); } catch (error) { throw new Error(`${String(error)}; page errors: ${errors.join("; ")}`, { cause: error }); }
        return { page, errors, warned };
      };
      let live: unknown;
      beforeAll(async () => {
        const reference = await open(async (page) => {
          // Live reads the same list through its host; the controller is the Angular build's.
          await page.setContent(`${Object.entries(files).flatMap(([name, source]) => name.endsWith(".html") ? [source.replace(/<link [^>]*>/g, "").replace(' controller="./table.js"', "")] : []).join("")}<page-products></page-products><page-warnings></page-warnings>`);
          await page.addScriptTag({ path: liveBundle });
          await page.evaluate(() => (window as unknown as { HtmlRuntime: { observeDocument(root: Document): void } }).HtmlRuntime.observeDocument(document));
          await frames(page);
        });
        live = await run(reference.page, reference.warned, `(() => { const table = document.querySelector("table");
          table.dataset.columns = Array.from(window.HtmlRuntime.getComponentHost(table).state.columns, (entry) => entry.header ?? entry.field ?? "-").join(); })()`);
        await reference.page.close();
        // The live reference itself: four then five columns, a moved column keeps its cells, a new row renders its cells.
        const { steps, kept, leftOut, warned } = live as { steps: string[]; kept: boolean; leftOut: string; warned: boolean[] };
        assert.match(steps[0]!, /^<table data-columns="Name,-,Q,W,N,P"><caption>6 columns<\/caption><thead><tr><th scope="col">Name<\/th><th class="numeric" scope="col"><abbr title="Price in US dollars" slot="header">Price<\/abbr><\/th>/);
        // A static prop converts by its declared type, a null bound prop takes its default, and context reaches cell content in every arm.
        assert.match(steps[0]!, /<tr><td>Desk lamp<\/td><td><b>Desk lamp:quiet:compact<\/b>49\|4\|Desk lamp<\/td><td><b>Desk lamp:quiet:compact<\/b><\/td><td>49<\/td>/);
        assert.match(steps[0]!, /<td><b>Notebook:quiet:compact<\/b>6.5\|4\|none<\/td><td><b>none:quiet:compact<\/b><\/td>/);
        assert.match(steps[0]!, /<tfoot><tr><td><i slot="note">kept<\/i>.<\/td><td>-<em>USD<\/em><\/td>/);
        assert.match(steps[1]!, /^<table data-columns="Id,Name,-,M,N,P"><caption>6 columns<\/caption><thead><tr><th scope="col">Id<\/th>/);
        assert.equal(steps[2], steps[0]);
        // A rejected bound prop takes its default too.
        assert.match(steps[4]!, /<tr><td>Pen<\/td><td><b>Pen:quiet:compact<\/b>2\|4\|none<\/td>/);
        assert.deepEqual({ kept, leftOut, warned }, { kept: true, leftOut: "A", warned: WARNED.map(() => true) });
        // After the drop, the next foot row's outlet holds the plain note.
        assert.match(steps.at(-1)!, /<tfoot><tr><td><i slot="note">kept<\/i>.<\/td>/);
      });

      it("renders the columns, follows consumer $if and keyed $each, and keeps cells by key like live", async () => {
        const { page, errors, warned } = await open(async (page) => {
          await page.setContent('<base href="http://localhost/"><app-root></app-root>');
          await page.addScriptTag({ path: angularBundle });
          await page.waitForFunction(() => document.body.dataset.ready === "true" && document.querySelector("table")?.dataset.columns !== undefined, undefined, { timeout: 5_000 });
        });
        try {
          assert.deepEqual(await run(page, warned), live);
          assert.deepEqual(errors, []);
        } finally { await page.close(); }
      });

      it("renders the columns complete on the server and hydrates them in place like live", async () => {
        const { page, errors, warned } = await open(async (page) => { await page.setContent(server); });
        try {
          // `$columns` is complete on the server: the caption, header row and cells read it before the client runs.
          assert.equal(await page.evaluate(READ), (live as { steps: string[] }).steps[0]!.replace(/ data-columns="[^"]*"/, ""));
          await page.evaluate(`window.server = Array.from(document.querySelectorAll("th, td, td *"))`);
          await page.addScriptTag({ path: angularBundle });
          await page.waitForFunction(() => document.body.dataset.ready === "true" && document.querySelector("table")?.dataset.columns !== undefined, undefined, { timeout: 5_000 });
          assert.equal(await page.evaluate(`window.server.every((node) => node.isConnected)`), true, "hydration keeps the server's cells");
          const result = await run(page, warned) as { warned: boolean[] };
          // Hydration warns again in the browser for left-out children, as each runtime does when it creates the component.
          assert.deepEqual(result, live);
          assert.deepEqual(errors, []);
        } finally { await page.close(); }
      });
    });
  }
});
