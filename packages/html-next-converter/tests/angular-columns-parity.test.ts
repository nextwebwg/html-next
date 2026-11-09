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
import { launchParityBrowser } from "../../html-next/tests/pixel-parity.js";
import { dynamicPlainSource, plainSlotExpected, plainSlotFiles, plainSlotInvocations, repeatedPlainSource } from "../../html-next/tests/fixtures/plain-slot-ownership.js";

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
const column = `<template component="x-column" summary="One column."><th $attributes scope="col"><slot name="header">{$header}</slot></th><defs>
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
const files: Readonly<Record<string, string>> = { "table.js": controller, "column.html": column, "table.html": table, "badge.html": badge, "products.html": products, "warnings.html": warnings,
  ...plainSlotFiles, "plain.html": `${dynamicPlainSource}${repeatedPlainSource}<template component="x-plain-page"><main>${plainSlotInvocations}<x-moving-page></x-moving-page><x-repeat-page></x-repeat-page></main></template>` };
const WARNED = [
  /`x-datatable`'s default slot accepts `x-column`; this `<x-colum>` is left out\./,
  /`x-datatable`'s default slot accepts `x-column`; this text is left out\./,
  /`<x-column-preset>` is a preset of `x-column`.*not supported yet/,
  /`cell` has props, so its content is a `<template slot="cell">`\./,
  /<slot of name="sum"> gives prop `extra`, which `x-column`'s slot `sum` does not declare\./,
  /<slot of name="sum"> must give prop `total`, which `x-column`'s slot `sum` declares as required\./,
  /Slot `cell` prop `label` does not satisfy its declared type `string`\./,
];

/** A hand-written consumer's reactive column props reach the header, the cells' field fallback and `host.state`. */
const checkRename = async (page: Page): Promise<void> => {
  await page.locator("button.rename").click();
  await frames(page);
  assert.deepEqual(await page.evaluate(`(() => { const table = document.querySelector("table"); return [table.dataset.columns.split(",")[0], table.querySelector("thead th").textContent.trim(), table.querySelector("tbody td").textContent.trim()]; })()`), ["Cost", "Cost", "6.5"]);
};

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

/** The compiled consumer, a hand-written Angular template, and hand-written columns rendered through ngTemplateOutlet. */
const CONSUMERS = [["compiled", "app-root"], ["hand-written", "hand-root"], ["ngTemplateOutlet", "outlet-root"]] as const;

const frames = (page: Page): Promise<void> => page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));

describe.skipIf(!enabled)("columns as markup in converted Angular", () => {
  let directory = "";
  let liveBundle = "";
  let angularBundle = "";
  const servers: Record<string, string> = {};

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-angular-columns-"));
    await symlink(nodeModules, join(directory, "node_modules"), "dir");
    await writeFile(join(directory, "package.json"), '{"type":"module"}');
    for (const [name, source] of Object.entries(files)) await writeFile(join(directory, name), source);
    liveBundle = join(directory, "live.js");
    await build({ entryPoints: [livePath], outfile: liveBundle, bundle: true, format: "iife", globalName: "HtmlRuntime", platform: "browser", target: ["es2022"] });

    const out = join(directory, "out");
    const manifest = await convertComponents({ mode: "application", target: "angular", root: directory, outDirectory: out, entries: ["products.html", "warnings.html", "plain.html", ...Object.keys(plainSlotFiles)] });
    const artifact = (tag: string): string => `./out/${manifest.components.find((entry) => entry.tag === tag)!.artifact.replace(/\.ts$/, "")}`;
    const app = join(directory, "app.ts");
    // Hand-written consumers of the same table, in an Angular component template: one declares the columns in the
    // table's content, the other in a template it renders there through ngTemplateOutlet, as a wrapper or a
    // dynamic renderer does. Each mirrors page-products, so each matches the live reference.
    const columns = `@if (showId()) { <th x-column field="id" header="Id"></th> }
  <th x-column [field]="nameField()" [header]="nameHeader()"><i slot="note">kept</i></th>
  <th x-column class="numeric"><abbr slot="header" title="Price in US dollars">Price</abbr>
    <ng-template x-column-cell let-row="row" let-width="width" let-label="label"><b x-badge [text]="$any(row?.name)"></b>{{ row?.price }}|{{ width! + 1 }}|{{ label }}</ng-template>
    <ng-template x-column-sum let-unit="unit"><em>{{ unit }}</em></ng-template></th>
  @if (showId()) { <th x-column field="id" header="M"></th> } @else { <th x-column header="Q"><ng-template x-column-cell let-label="label"><b x-badge [text]="label"></b></ng-template></th> }
  @if (!showId()) { <th x-column field="price" header="W"></th> }
  @for (column of extra(); track column.key) { <th x-column [field]="column.key" [header]="column.label"></th> }`;
    const consumer = (selector: string, table: string): string => `@Component({ selector: "main[${selector}]", standalone: true, imports: [NgTemplateOutlet, XDatatable, XColumn, XColumnCellSlot, XColumnSumSlot, XBadge], template: \`
  <button type="button" class="toggle" (click)="showId.set(!showId())">Id</button><button type="button" class="swap" (click)="extra.set([{ key: 'price', label: 'P' }, { key: 'name', label: 'N' }])">Swap</button>
  <button type="button" class="add" (click)="products.set([one, two, { id: 3, name: 'Pen', price: 2 }])">Add</button><button type="button" class="drop" (click)="products.set([two, { id: 3, name: 'Pen', price: 2 }])">Drop</button>
  <button type="button" class="rename" (click)="nameField.set('price'); nameHeader.set('Cost')">Rename</button>
  ${table}\` })
class ${selector === "hand-products" ? "HandProducts" : "OutletProducts"} {
  readonly one = { id: 1, name: "Desk lamp", price: 49 }; readonly two = { id: 2, name: "Notebook", price: 6.5 };
  readonly products = signal([this.one, this.two]); readonly showId = signal(false);
  readonly nameField = signal("name"); readonly nameHeader = signal("Name");
  readonly extra = signal([{ key: "name", label: "N" }, { key: "price", label: "P" }]);
}`;
    await writeFile(app, `import { Component, signal } from "@angular/core";
import { NgTemplateOutlet } from "@angular/common";
import PageProducts from "${artifact("page-products")}";
import PageWarnings from "${artifact("page-warnings")}";
import XDatatable from "${artifact("x-datatable")}";
import XColumn, { XColumnCellSlot, XColumnSumSlot } from "${artifact("x-column")}";
import XBadge from "${artifact("x-badge")}";
import PlainPage from "${artifact("x-plain-page")}";
@Component({ selector: "app-root", standalone: true, imports: [PageProducts, PageWarnings], template: '<main page-products></main><section page-warnings></section>' }) export class App {}
@Component({ selector: "plain-root", standalone: true, imports: [PlainPage], template: '<main x-plain-page></main>' }) export class PlainApp {}
${consumer("hand-products", `<table x-datatable [rows]="products()">${columns}</table>`)}
${consumer("outlet-products", `<table x-datatable [rows]="products()"><ng-container [ngTemplateOutlet]="columns"></ng-container></table><ng-template #columns>${columns}</ng-template>`)}
@Component({ selector: "hand-root", standalone: true, imports: [HandProducts, PageWarnings], template: '<main hand-products></main><section page-warnings></section>' }) export class HandApp {}
@Component({ selector: "outlet-root", standalone: true, imports: [OutletProducts, PageWarnings], template: '<main outlet-products></main><section page-warnings></section>' }) export class OutletApp {}
@Component({ selector: "warn-root", standalone: true, imports: [XDatatable, XColumn], template: \`<table x-datatable [rows]="[{ id: 1, name: 'A', price: 1 }]"><th x-column field="name"></th><th x-column><span slot="cell">plain</span></th></table>\` }) export class WarnApp {}`);
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
import { App, HandApp, OutletApp, WarnApp, PlainApp } from ${JSON.stringify(compiled)};
const [selector, root] = ([["app-root", App], ["hand-root", HandApp], ["outlet-root", OutletApp], ["warn-root", WarnApp], ["plain-root", PlainApp]] as const).find(([selector]) => document.querySelector(selector) !== null)!;
bootstrapApplication(root, { providers: document.querySelector(selector)!.hasAttribute("ngh") ? [provideClientHydration()] : [] }).then(app => { window.destroyTarget = () => { app.destroy(); return app.viewCount; }; document.body.dataset.ready = "true"; });`);
    angularBundle = join(directory, "angular.js");
    await build({ entryPoints: [browserEntry], outfile: angularBundle, bundle: true, format: "iife", platform: "browser", target: ["es2022"], loader: { ".css": "empty" }, nodePaths: [nodeModules] });
    const serverEntry = join(directory, "server.ts");
    await writeFile(serverEntry, `import "@angular/compiler";
import { renderApplication, provideServerRendering } from "@angular/platform-server";
import { bootstrapApplication, provideClientHydration } from "@angular/platform-browser";
import { App, HandApp, OutletApp, PlainApp } from ${JSON.stringify(compiled)};
const roots = { "app-root": App, "hand-root": HandApp, "outlet-root": OutletApp, "plain-root": PlainApp };
export const render = (selector: keyof typeof roots) => renderApplication(context => bootstrapApplication(roots[selector], { providers: [provideServerRendering(), provideClientHydration()] }, context),
  { document: \`<html><head><base href="http://localhost/"></head><body><\${selector}></\${selector}></body></html>\`, url: "http://localhost/", allowedHosts: ["localhost"] });`);
    const serverBundle = join(directory, "server.mjs");
    await build({ entryPoints: [serverEntry], outfile: serverBundle, bundle: true, format: "esm", platform: "node", packages: "external", loader: { ".css": "empty" } });
    const { render } = await import(pathToFileURL(serverBundle).href) as { render(selector: string): Promise<string> };
    for (const [, selector] of CONSUMERS) servers[selector] = await render(selector);
    servers["plain-root"] = await render("plain-root");
  }, 240_000);

  afterAll(async () => { if (directory !== "" && process.env.HTMLNEXT_KEEP !== "1") await rm(directory, { recursive: true, force: true }); });

  for (const [engine, browserType] of [["Chromium", chromium], ["Firefox", firefox], ["WebKit", webkit]] as const satisfies ReadonlyArray<readonly [string, BrowserType]>) {
    describe(engine, () => {
      let browser: Browser;
      beforeAll(async () => { browser = await launchParityBrowser(browserType); });
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

      it("warns about a hand-written consumer's plain content for a slot with props, and shows the fallback", async () => {
        const { page, errors, warned } = await open(async (page) => {
          await page.setContent('<base href="http://localhost/"><warn-root></warn-root>');
          await page.addScriptTag({ path: angularBundle });
          await page.waitForFunction(() => document.body.dataset.ready === "true" && document.querySelector("table")?.dataset.columns !== undefined, undefined, { timeout: 5_000 });
        });
        try {
          await frames(page);
          assert.equal(await page.evaluate(`document.querySelector("tbody").textContent.replace(/\\s+/g, "")`), "A");
          assert.ok(warned.some((text) => /`cell` has props, so its content is a `<template slot="cell">`\./.test(text)), warned.join("\n"));
          assert.deepEqual(errors, []);
        } finally { await page.close(); }
      });

      it("hydrates own and borrowed plain ranges with editable controls through transfers and reconnect", async () => {
        const { page, errors } = await open(async page => { await page.setContent(servers["plain-root"]!); });
        const read = () => page.locator("[data-plain-case] > section").evaluateAll(sections => sections.map(section => Array.from(section.children, child => [child.localName, child.textContent])));
        try {
          assert.deepEqual(await read(), plainSlotExpected);
          for (const [name, text] of [["data-repeated-lazy", "Fresh"], ["data-default-lazy", "DefaultFresh"]]) {
            assert.deepEqual(await page.locator(`[${name}] i`).allTextContents(), [text, text]);
          }
          await page.locator("[data-moving-plain] input").fill("Before hydration");
          await page.locator("[data-repeated-plain] input").fill("Kept");
          await page.addScriptTag({ path: angularBundle });
          await page.waitForFunction(() => document.body.dataset.ready === "true");
          await frames(page);
          assert.deepEqual(errors, []);
          assert.deepEqual(await read(), plainSlotExpected);
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
          const placed = () => page.locator("[data-moving-plain] > b, [data-moving-plain] > p").evaluateAll(nodes => nodes.map(node => [node.localName, node.textContent]));
          for (const [action, expected] of [
            ["borrowed", [["b", "Plain"]]],
            ["borrowed", [["p", "BorrowedFallback"], ["b", "Plain"]]],
            ["root", [["p", "Plain"]]],
            ["root", [["p", "Plain"], ["b", "OwnFallback"]]],
          ] as const) {
            await page.locator(`[data-plain-action="${action}"]`).click(); await frames(page);
            assert.deepEqual(await placed(), expected); await editable();
          }
          for (const expected of ["", "Plain"]) {
            await page.locator('[data-plain-action="content"]').click(); await frames(page);
            assert.equal(await page.locator("[data-moving-plain] > p").textContent(), expected); await editable();
          }
          await page.locator('[data-plain-action="first"]').click(); await frames(page); await editable();
          assert.ok(await page.locator("[data-repeated-plain] footer").evaluate(node => node.matches(":last-child")));
          await page.evaluate(async () => {
            const root = document.querySelector("plain-root")!, parent = root.parentNode!, next = root.nextSibling;
            root.remove(); await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
            parent.insertBefore(root, next);
          });
          await frames(page); await editable();
          assert.equal(await page.evaluate(() => (window as any).destroyTarget()), 0);
          assert.equal(await page.evaluate(() => (document as any)[Symbol.for("@nextwebwg/html-next.runtime.v1")]?.mutationHub?.subscribers.size ?? 0), 0);
          assert.deepEqual(errors, []);
        } finally { await page.close(); }
      });

      for (const [consumer, selector] of CONSUMERS) {
        it(`renders the ${consumer} consumer's columns, follows its conditions and keyed loop, and keeps cells by key like live`, async () => {
          const { page, errors, warned } = await open(async (page) => {
            await page.setContent(`<base href="http://localhost/"><${selector}></${selector}>`);
            await page.addScriptTag({ path: angularBundle });
            try { await page.waitForFunction(() => document.body.dataset.ready === "true" && document.querySelector("table")?.dataset.columns !== undefined, undefined, { timeout: 5_000 }); }
            catch (error) { throw new Error(`${String(error)}; page errors: ${errors.join("; ")}`, { cause: error }); }
          });
          try {
            assert.deepEqual(await run(page, warned), live);
            if (consumer !== "compiled") await checkRename(page);
            assert.deepEqual(errors, []);
          } finally { await page.close(); }
        });

        it(`renders the ${consumer} consumer's columns on the server and hydrates them in place like live`, async () => {
          const { page, errors, warned } = await open(async (page) => { await page.setContent(servers[selector]!); });
          try {
            // `$columns` is complete on the server: the caption, header row and cells read it before the client runs.
            assert.equal(await page.evaluate(READ), (live as { steps: string[] }).steps[0]!.replace(/ data-columns="[^"]*"/, ""));
            await page.evaluate(`window.server = Array.from(document.querySelectorAll("th, td, td *"))`);
            await page.addScriptTag({ path: angularBundle });
            try { await page.waitForFunction(() => document.body.dataset.ready === "true" && document.querySelector("table")?.dataset.columns !== undefined, undefined, { timeout: 5_000 }); }
            catch (error) { throw new Error(`${String(error)}; page errors: ${errors.join("; ")}`, { cause: error }); }
            assert.equal(await page.evaluate(`window.server.every((node) => node.isConnected)`), true, "hydration keeps the server's cells");
            const result = await run(page, warned) as { warned: boolean[] };
            // Hydration warns again in the browser for left-out children, as each runtime does when it creates the component.
            assert.deepEqual(result, live);
            if (consumer !== "compiled") await checkRename(page);
            assert.deepEqual(errors, []);
          } finally { await page.close(); }
        });
      }
    });
  }
});
