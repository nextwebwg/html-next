import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";

import { compileScript, compileTemplate, parse as parseVue } from "@vue/compiler-sfc";
import { build, type BuildOptions } from "esbuild";
import { chromium, firefox, webkit, type BrowserType, type Page } from "playwright";

import { convertComponents } from "../src/index.js";

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

const source = `<template component="x-column" status="early" summary="Column."><th scope="col"><slot name="header">{$header}</slot></th>
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
    </x-datatable></div></template>`;
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
    const options: BuildOptions = { bundle: true, format: "iife", platform: "browser", target: ["es2022"], nodePaths: [nodeModules], plugins: [sfc] };
    await writeFile(join(out, "entry.ts"), `import { createApp, h } from "vue"; import App from "./${artifact}"; createApp({ render: () => h(App) }).mount("#mount");`);
    await build({ ...options, entryPoints: [join(out, "entry.ts")], outfile: fresh = join(directory, "vue.js") });
    await writeFile(join(out, "hydrate.ts"), `import { createSSRApp, h } from "vue"; import App from "./${artifact}"; createSSRApp({ render: () => h(App) }).mount("#mount");`);
    await build({ ...options, entryPoints: [join(out, "hydrate.ts")], outfile: hydrate = join(directory, "hydrate.js") });
    await writeFile(join(out, "server.ts"), `import { createSSRApp, h } from "vue"; import { renderToString } from "@vue/server-renderer"; import App from "./${artifact}";
export const render = () => renderToString(createSSRApp({ render: () => h(App) }));`);
    const serverBuild = await build({ entryPoints: [join(out, "server.ts")], bundle: true, format: "esm", platform: "node", write: false, nodePaths: [serverModules, nodeModules], plugins: [ssrSfc] });
    const module = await import(`data:text/javascript;base64,${Buffer.from(serverBuild.outputFiles[0]!.text).toString("base64")}`) as { render(): Promise<string> };
    server = await module.render();
  }, 180_000);
  afterAll(async () => { if (directory !== "") await rm(directory, { recursive: true, force: true }); });

  for (const [engine, browserType] of [["Chromium", chromium], ["Firefox", firefox], ["WebKit", webkit]] as const satisfies ReadonlyArray<readonly [string, BrowserType]>) {
    it(`${engine} renders, updates and hydrates the tables like live`, async () => {
      const browser = await browserType.launch({ headless: true });
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

        let taken = (now: string[]): string[] => now;
        const step = async (button: string, check?: (tables: readonly string[]) => readonly string[] | void): Promise<void> => {
          for (const page of Object.values(pages)) await page.evaluate(mark);
          for (const page of Object.values(pages)) await page.locator(`button.${button}`).click();
          await pages.live.waitForTimeout(50);
          await pages.live.evaluate(LIVE_CONTROLLERS);
          await pages.live.waitForTimeout(20);
          const read = taken(await tables(pages.live));
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
        // When the first outlet goes, the plain note moves to the column's next outlet. Live's takeover
        // fix lands on its own branch; until it merges, live leaves the note out, so this states the outcome.
        taken = (now) => now.map((table, index) => index === 0 ? table.replace("<tfoot><tr><td></td>", '<tfoot><tr><td><i slot="note">kept</i></td>') : table);
        await step("unlead");
        for (const button of ["widen", "retag", "widen"]) await step(button);
        const final = taken(await tables(pages.live));
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
