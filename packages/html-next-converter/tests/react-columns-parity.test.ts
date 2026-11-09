import { launchParityBrowser } from "../../html-next/tests/pixel-parity.js";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, it } from "vitest";

import { build } from "esbuild";
import { createElement as reactElement, type ComponentType as ReactComponent } from "react";
import { renderToString as renderReact } from "react-dom/server";
import { createElement as preactElement, type ComponentType as PreactComponent } from "preact";
import { renderToString as renderPreact } from "preact-render-to-string";
import { chromium, firefox, webkit, type BrowserType, type Page } from "playwright";

import { convertComponents } from "../src/index.js";

/**
 * Columns as markup (https://nextwebwg.org/declarative-components/components#columns-as-markup) in
 * converted React and Preact components, against the live runtime: the spec's data table, a consumer
 * `$if` column, keyed `$each` columns reordered with their cells, context read from cell content
 * through the column and then the table, `$columns.length` before the header row, and plain slot
 * content placed once. Each target mounts in the browser and hydrates its own server output.
 */
const enabled = process.env.HTMLNEXT_TARGET_TEST === "1";
const run = promisify(execFile);
const nodeModules = fileURLToPath(new URL("../node_modules", import.meta.url));

// A table-part root comes before its <defs>: a template whose first start tag is <defs> drops the <th>.
const source = `<template component="x-column" status="early" summary="One column."><th $attributes scope="col"><slot name="header">{$header}</slot></th><defs>
  <prop name="field" type="string">The row field a cell shows when no cell content is given.</prop>
  <prop name="header" type="string">The header text.</prop>
  <state name="tone" type="string" value="quiet"></state>
  <slot name="header"></slot><slot name="note"></slot>
  <slot name="cell"><prop name="row" type="object" required>The row this cell shows.</prop></slot>
  <slot name="tag"><prop name="size" type="number">Size.</prop><prop name="unit" type="string" default="px">Unit.</prop><prop name="label" type="string" required>Label.</prop></slot></defs></template>
<template component="x-datatable" status="early" summary="A table whose columns are its x-column children." controller="./table.js"><defs>
  <prop name="rows" type="list(object({ id: number, name: string, price: number }))" required>One entry per table row.</prop>
  <state name="density" type="string" value="compact"></state>
  <slot accepts="x-column" as="columns"></slot></defs>
  <table><caption>{$columns.length} columns</caption><thead><tr><template $slot></template></tr></thead>
  <tbody><tr $each="row of $rows" $key="$row.id"><td $each="column of $columns" $key="$column"><slot of="$column" name="cell" from:row="$row">{$row[$column.field]}</slot></td></tr></tbody>
  <tfoot><tr><td $each="column of $columns" $key="$column"><slot of="$column" name="note">-</slot><slot of="$column" name="note"></slot><slot of="$column" name="tag" size="3" extra="x"></slot></td></tr></tfoot></table></template>
<template component="x-badge" status="early" summary="Reads both table contexts."><defs><prop name="text" type="string">Text.</prop>
  <context name="tone" from="x-column"></context><context name="density" from="x-datatable"></context></defs>
  <b>{$text}:{$tone}:{$density}</b></template>
<template component="x-column-preset" status="early" summary="A preset."><x-column field="name"></x-column></template>
<template component="x-first" status="early" summary="Reads its list before its outlet."><defs><slot accepts="x-column" as="columns"></slot></defs>
  <section><p $each="column of $columns" $key="$column"><slot of="$column" name="note">{$column.header}</slot></p><table><thead><tr><template $slot></template></tr></thead></table></section></template>
<template component="x-products" status="early" summary="Products."><defs>
  <state name="products" type="list(object({ id: number, name: string, price: number }))"
    value="[{ id: 1, name: 'Desk lamp', price: 49 }, { id: 2, name: 'Notebook', price: 6.5 }]"></state>
  <state name="showId" type="boolean" value="false"></state>
  <state name="extra" type="list(object({ key: string, label: string }))" value="[{ key: 'name', label: 'N' }, { key: 'price', label: 'P' }]"></state>
  <handler name="toggle"><set name="showId" expr:value="not $showId"></set></handler>
  <handler name="swap"><set name="extra" expr:value="[{ key: 'price', label: 'P' }, { key: 'name', label: 'N' }]"></set></handler>
  <handler name="rename"><set name="products" expr:value="[{ id: 2, name: 'Notebook', price: 6.5 }, { id: 1, name: 'Lamp', price: 49 }, { id: 3, name: 'Pen', price: 2 }]"></set></handler>
  </defs><main><button type="button" class="toggle" on:click="toggle">Id</button><button type="button" class="swap" on:click="swap">Swap</button>
  <button type="button" class="rename" on:click="rename">Rename</button><x-datatable from:rows="$products">
    <x-column $if="$showId" field="id" header="Id"></x-column>
    <x-column field="name" header="Name"><i slot="note">kept</i></x-column>
    <x-column class="numeric"><abbr slot="header" title="Price in US dollars">Price</abbr>
      <template slot="cell"><span><x-badge from:text="$row.name"></x-badge></span>{$row.price}</template></x-column>
    <x-column $each="column of $extra" $key="$column.key" from:field="$column.key" from:header="$column.label"></x-column>
  </x-datatable></main></template>
<template component="x-warned" status="early" summary="Warned."><main><x-datatable from:rows="[{ id: 1, name: 'A', price: 1 }]">
  <x-column field="name"></x-column><span>no</span>stray<x-column-preset></x-column-preset>
  <x-column><span slot="cell">plain</span></x-column></x-datatable></main></template>
<template component="x-more" status="early" summary="More."><defs>
  <state name="wide" type="boolean" value="false"></state>
  <state name="tags" type="list(string)" value="['p', 'q']"></state>
  <handler name="widen"><set name="wide" expr:value="not $wide"></set></handler>
  <handler name="retag"><set name="tags" expr:value="['q', 'r']"></set></handler>
  </defs><main><button type="button" class="widen" on:click="widen">Widen</button><button type="button" class="retag" on:click="retag">Retag</button>
  <x-datatable from:rows="[{ id: 1, name: 'A', price: 1 }]">
    <template $match><x-column $when="$wide" field="price" header="Wide"></x-column><x-column $else field="name" header="Narrow"><template slot="note"><u>n</u></template></x-column></template>
    <template $each="tag of $tags" $key="$tag"><x-column from:header="$tag"><template slot="cell"><x-badge from:text="$tag"></x-badge></template><template slot="tag"><em>{$size + 1}{$unit}</em></template></x-column></template>
  </x-datatable></main></template>`;
/** Reads the table's `as` list from its controller. */
const controller = `export default function initialize(host) {
  return host.effect(() => host.root.setAttribute("data-columns", host.state.columns.map((column) => column.header ?? column.field ?? "-").join(",")));
}`;

/**
 * Hand-written consumers in each framework's own JSX, giving the same tables as `x-products`,
 * `x-more` and `x-warned`: columns written directly, in a conditional and in a keyed loop, `slots`
 * render props and plain content, and a column whose props change in place.
 */
const hand = (target: Target, entry: string): string => `${target === "preact" ? `/** @jsxImportSource preact */
import { useLayoutEffect, useState } from "preact/hooks";` : `import { StrictMode, startTransition, Suspense, use, useLayoutEffect, useState } from "react";`}
import { XBadge, XColumn, XColumnPreset, XDatatable, XFirst } from "./${entry}";
export function HandProducts() {
  const [products, setProducts] = useState([{ id: 1, name: "Desk lamp", price: 49 }, { id: 2, name: "Notebook", price: 6.5 }]);
  const [showId, setShowId] = useState(false);
  const [extra, setExtra] = useState([{ key: "name", label: "N" }, { key: "price", label: "P" }]);
  return <main><button type="button" className="toggle" onClick={() => setShowId(!showId)}>Id</button>
    <button type="button" className="swap" onClick={() => setExtra([{ key: "price", label: "P" }, { key: "name", label: "N" }])}>Swap</button>
    <button type="button" className="rename" onClick={() => setProducts([{ id: 2, name: "Notebook", price: 6.5 }, { id: 1, name: "Lamp", price: 49 }, { id: 3, name: "Pen", price: 2 }])}>Rename</button>
    <XDatatable rows={products}>
      {showId && <XColumn field="id" header="Id" />}
      <XColumn field="name" header="Name" slots={{ note: <i>kept</i> }} />
      <XColumn className="numeric" slots={{ header: <abbr title="Price in US dollars">Price</abbr>,
        cell: ({ row }: { row: any }) => <><span><XBadge text={row.name} /></span>{row.price}</> }} />
      {extra.map((column) => <XColumn key={column.key} field={column.key} header={column.label} />)}
    </XDatatable></main>;
}
export function HandMore() {
  const [wide, setWide] = useState(false);
  const [tags, setTags] = useState(["p", "q"]);
  return <main><button type="button" className="widen" onClick={() => setWide(!wide)}>Widen</button>
    <button type="button" className="retag" onClick={() => setTags(["q", "r"])}>Retag</button>
    <XDatatable rows={[{ id: 1, name: "A", price: 1 }]}>
      {wide ? <XColumn field="price" header="Wide" /> : <XColumn field="name" header="Narrow" slots={{ note: () => <u>n</u> }} />}
      {tags.map((tag) => <XColumn key={tag} header={tag} slots={{ cell: () => <XBadge text={tag} />,
        tag: ({ size, unit }: { size: number; unit: string }) => <em>{size + 1}{unit}</em> }} />)}
    </XDatatable></main>;
}
export function HandWarned() {
  return <main><XDatatable rows={[{ id: 1, name: "A", price: 1 }]}>
    <XColumn field="name" /><span>no</span>stray<XColumnPreset />
    <XColumn slots={{ cell: <span>plain</span> as any }} /></XDatatable></main>;
}
function IdColumn({ show }: { show: boolean }) { return show ? <XColumn field="id" header="Id" /> : null; }
function PriceColumn() {
  return <XColumn className="numeric" slots={{ header: <abbr title="Price in US dollars">Price</abbr>,
    cell: ({ row }: { row: any }) => <><span><XBadge text={row.name} /></span>{row.price}</> }} />;
}
function ExtraColumn({ column }: { column: { key: string; label: string } }) { return <XColumn field={column.key} header={column.label} />; }
export function WrappedProducts() {
  const [products, setProducts] = useState([{ id: 1, name: "Desk lamp", price: 49 }, { id: 2, name: "Notebook", price: 6.5 }]);
  const [showId, setShowId] = useState(false);
  const [extra, setExtra] = useState([{ key: "name", label: "N" }, { key: "price", label: "P" }]);
  return <main><button type="button" className="toggle" onClick={() => setShowId(!showId)}>Id</button>
    <button type="button" className="swap" onClick={() => setExtra([{ key: "price", label: "P" }, { key: "name", label: "N" }])}>Swap</button>
    <button type="button" className="rename" onClick={() => setProducts([{ id: 2, name: "Notebook", price: 6.5 }, { id: 1, name: "Lamp", price: 49 }, { id: 3, name: "Pen", price: 2 }])}>Rename</button>
    <XDatatable rows={products}>
      <IdColumn show={showId} />
      <XColumn field="name" header="Name" slots={{ note: <i>kept</i> }} />
      <PriceColumn />
      {extra.map((column) => <ExtraColumn key={column.key} column={column} />)}
    </XDatatable></main>;
}
function MatchColumn({ wide }: { wide: boolean }) {
  return wide ? <XColumn field="price" header="Wide" /> : <XColumn field="name" header="Narrow" slots={{ note: () => <u>n</u> }} />;
}
function TagColumn({ tag }: { tag: string }) {
  return <XColumn header={tag} slots={{ cell: () => <XBadge text={tag} />, tag: ({ size, unit }: { size: number; unit: string }) => <em>{size + 1}{unit}</em> }} />;
}
export function WrappedMore() {
  const [wide, setWide] = useState(false);
  const [tags, setTags] = useState(["p", "q"]);
  return <main><button type="button" className="widen" onClick={() => setWide(!wide)}>Widen</button>
    <button type="button" className="retag" onClick={() => setTags(["q", "r"])}>Retag</button>
    <XDatatable rows={[{ id: 1, name: "A", price: 1 }]}>
      <MatchColumn wide={wide} />
      {tags.map((tag) => <TagColumn key={tag} tag={tag} />)}
    </XDatatable></main>;
}
/** A wrapper whose own state changes its columns: the table re-renders only because the columns tell it to. */
function PairColumns() {
  const [state, setState] = useState({ label: "B", field: "price", flip: false, more: false, off: false });
  useLayoutEffect(() => { (window as any).pair = (next: object) => setState({ ...state, ...next }); });
  const columns = [<XColumn key="b" field={state.field} header={state.label} />, <XColumn key="c" field="id" header="C" />];
  if (state.more) columns.splice(1, 0, <XColumn key="m" field="name" header="M" />);
  if (state.flip) columns.reverse();
  return <>{state.off ? null : columns}</>;
}
function NotAColumn() { return null; }
function LastColumn() {
  return <XColumn header="Last" slots={{ cell: ({ row }: { row: any }) => <XBadge text={row.name} />, note: <i>kept</i> }} />;
}
export function WrappedOwnState() {
  const [last, setLast] = useState(true);
  const [note, setNote] = useState(true);
  return <main><button type="button" className="last" onClick={() => setLast(!last)}>Last</button>
    <button type="button" className="note" onClick={() => setNote(!note)}>Note</button>
    <XDatatable rows={[{ id: 1, name: "A", price: 2 }]}>
      <XColumn field="name" header="Direct" slots={note ? { note: <i>direct</i> } : {}} />
      <NotAColumn />
      <PairColumns />
      {last && <LastColumn />}
    </XDatatable></main>;
}
function NoteColumn({ count }: { count: number }) { return <XColumn header="H" slots={{ note: <b>{"N" + count}</b> }} />; }
export function WrappedFirst() {
  const [count, setCount] = useState(0);
  return <main><button type="button" className="count" onClick={() => setCount(count + 1)}>Count</button>
    <XFirst><XColumn header="D" /><NoteColumn count={count} /></XFirst></main>;
}
${target === "preact" ? `export const StrictProducts = WrappedProducts;
export const Discarded = WrappedOwnState;` : `export function StrictProducts() { return <StrictMode><WrappedProducts /></StrictMode>; }
const never = new Promise<never>(() => {});
function Never(): null { return use(never); }
/** A transition that renders new wrapped columns and suspends, so React discards that render. */
export function Discarded() {
  const [pending, setPending] = useState(false);
  const [rows, setRows] = useState([{ id: 1, name: "A", price: 2 }]);
  return <main><button type="button" className="pending" onClick={() => startTransition(() => setPending(true))}>Pending</button>
    <button type="button" className="urgent" onClick={() => setRows([{ id: 2, name: "B", price: 3 }])}>Urgent</button>
    <Suspense fallback={<p>fallback</p>}>
      <XDatatable rows={rows}>
        <XColumn field="name" header="Direct" />
        <ExtraColumn column={{ key: "price", label: "Price" }} />
        {pending && <><ExtraColumn column={{ key: "id", label: "Lost" }} /><Never /></>}
      </XDatatable>
    </Suspense></main>;
}`}
`;
const PAGES = { XProducts: "", XWarned: "#warned", XMore: "#more", HandProducts: "#hand-products", HandWarned: "#hand-warned", HandMore: "#hand-more",
  WrappedProducts: "#wrapped-products", WrappedMore: "#wrapped-more", WrappedOwnState: "#wrapped-own-state", WrappedFirst: "#wrapped-first", StrictProducts: "#strict-products", Discarded: "#discarded" } as const;
type PageName = keyof typeof PAGES;

/** The rendered tables without marks, carriers or runtime attributes. */
const READ = `Array.from(document.querySelectorAll("table"), (table) => {
  const read = (node) => {
    if (node.nodeType === 3) return node.data.trim();
    if (node.nodeType !== 1 || node.localName === "template") return "";
    const keep = ["class", "scope", "title", "slot"].filter((name) => node.hasAttribute(name)).map((name) => " " + name + '="' + node.getAttribute(name) + '"');
    return "<" + node.localName + keep.join("") + ">" + Array.from(node.childNodes, read).join("") + "</" + node.localName + ">";
  };
  return read(table);
}).concat(Array.from(document.querySelectorAll("[data-columns]"), (root) => "columns: " + root.getAttribute("data-columns"))).join("\\n")`;

type Target = "react" | "preact";
type Mode = "mount" | "hydrate";

describe.skipIf(!enabled)("columns as markup in React and Preact", () => {
  let directory = "";
  let liveBundle = "";
  const bundles = new Map<Target, string>();
  const servers = new Map<string, string>();

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-react-columns-"));
    await symlink(nodeModules, join(directory, "node_modules"), "dir");
    await writeFile(join(directory, "package.json"), '{"type":"module"}');
    await mkdir(join(directory, "components"));
    await writeFile(join(directory, "components/table.html"), source);
    await writeFile(join(directory, "components/table.js"), controller);
    liveBundle = join(directory, "live.js");
    await build({ entryPoints: [fileURLToPath(new URL("../../html-next/src/live.ts", import.meta.url))], outfile: liveBundle,
      bundle: true, format: "iife", globalName: "HtmlRuntime", platform: "browser", target: ["es2022"] });
    for (const target of ["react", "preact"] as const) {
      const out = join(directory, target);
      const manifest = await convertComponents({ mode: "application", target, root: directory, outDirectory: out, entries: ["components/**"] });
      const entry = join(out, "mount.tsx");
      const generated = manifest.output.entry.replace(/\.tsx?$/, "");
      await writeFile(join(out, "hand.tsx"), hand(target, generated));
      await writeFile(join(out, "pages.tsx"), `export { XMore, XProducts, XWarned } from "./${generated}";\nexport * from "./hand";`);
      const pick = `const App = (pages as Record<string, any>)[Object.entries(${JSON.stringify(PAGES)}).find(([, hash]) => hash === location.hash)![0]];`;
      await writeFile(entry, target === "react" ? `import { createRoot, hydrateRoot } from "react-dom/client";
import * as pages from "./pages";
${pick}
const mount = document.querySelector("#mount")!;
if (mount.hasChildNodes()) hydrateRoot(mount, <App />); else createRoot(mount).render(<App />);`
        : `/** @jsxImportSource preact */
import { hydrate, render } from "preact";
import * as pages from "./pages";
${pick}
const mount = document.querySelector("#mount")!;
if (mount.hasChildNodes()) hydrate(<App />, mount); else render(<App />, mount);`);
      const bundle = join(out, "mount.js");
      await build({ entryPoints: [entry], outfile: bundle, bundle: true, format: "iife", platform: "browser", target: ["es2022"], jsx: "automatic",
        loader: { ".css": "empty" }, nodePaths: [nodeModules] });
      bundles.set(target, bundle);
      const server = join(out, "server.mjs");
      await build({ entryPoints: [join(out, "pages.tsx")], outfile: server, bundle: true, platform: "node", format: "esm",
        packages: "external", jsx: "automatic", loader: { ".css": "empty" } });
      const components = await import(pathToFileURL(server).href) as Record<string, unknown>;
      for (const name of Object.keys(PAGES)) {
        servers.set(`${target}:${name}`, target === "react" ? renderReact(reactElement(components[name] as ReactComponent))
          : renderPreact(preactElement(components[name] as PreactComponent, {})));
      }
    }
  }, 180_000);
  afterAll(async () => { if (directory !== "") await rm(directory, { recursive: true, force: true }); });

  it("types the React output: entries by the accepted component's props, and each column's declared slots", async () => {
    await writeFile(join(directory, "tsconfig.json"), JSON.stringify({ compilerOptions: {
      target: "ES2022", module: "ESNext", moduleResolution: "Bundler", strict: true, skipLibCheck: true, jsx: "react-jsx", noEmit: true, allowImportingTsExtensions: true,
    }, include: ["react/react/**/*.ts", "react/react/**/*.tsx"] }));
    const { stdout } = await run(process.execPath, [fileURLToPath(new URL("../node_modules/typescript/bin/tsc", import.meta.url)), "-p", directory])
      .catch((error: { stdout?: string }) => ({ stdout: error.stdout ?? String(error) }));
    // The one error: the warned page gives plain content to `cell`, whose type takes its declared `row`.
    assert.equal(stdout.match(/error TS/g)?.length, 1, stdout);
    assert.match(stdout, /XWarned\.tsx\(\d+,\d+\): error TS2322: Type 'Element' is not assignable to type '\(props: \{ readonly row: /);
    assert.match(await readFile(join(directory, "react/react/components/XDatatable.tsx"), "utf8"), /const columns = htmlNextLists\.lists\["columns"\] as \{\s*field: string \| null;\s*header: string \| null;\s*\}\[\];/);
  }, 60_000);

  const openLive = async (page: Page, tag: string): Promise<string[]> => {
    const warnings: string[] = [];
    page.on("console", (message) => { if (message.type() === "warning") warnings.push(message.text()); });
    await page.setContent(`${source}<div id="mount"><${tag}></${tag}></div>`);
    await page.addScriptTag({ path: liveBundle });
    await page.evaluate(`window.HtmlRuntime.observeDocument(document)`);
    // The table's controller, given each table's host as live's loader would.
    await page.evaluate(`(() => { const initialize = ${controller.replace("export default ", "")};
      for (const table of document.querySelectorAll("table")) initialize(window.HtmlRuntime.getComponentHost(table, "x-datatable")); })()`);
    return warnings;
  };
  const openTarget = async (page: Page, target: Target, mode: Mode, name: PageName): Promise<string[]> => {
    const warnings: string[] = [];
    page.on("console", (message) => { if (message.type() === "warning") warnings.push(message.text()); });
    await page.route("https://app.example/**", (route) => route.fulfill({ contentType: "text/html",
      body: `<div id="mount">${mode === "hydrate" ? servers.get(`${target}:${name}`)! : ""}</div>` }));
    await page.goto(`https://app.example/${PAGES[name]}`);
    await page.evaluate(`window.serverCells = Array.from(document.querySelectorAll("td, th"))`);
    await page.addScriptTag({ path: bundles.get(target)! });
    await page.locator("table").first().waitFor();
    return warnings;
  };
  const settle = (page: Page) => page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  // A hand-written consumer gives slot content as `slots`, so its elements carry no `slot` attribute.
  const tables = async (page: Page, expected?: string, hand: boolean | "wrapped" = false): Promise<string> => {
    const read = hand ? `(${READ}).replace(/ slot="[a-z]+"/g, "")` : READ;
    if (expected !== undefined) await page.waitForFunction(`${read} === ${JSON.stringify(expected)}`, undefined, { timeout: 5_000 }).catch(() => {});
    await settle(page);
    return page.evaluate(read) as Promise<string>;
  };

  for (const [engine, browserType] of [["Chromium", chromium], ["Firefox", firefox], ["WebKit", webkit]] as const satisfies ReadonlyArray<readonly [string, BrowserType]>) {
    for (const target of ["react", "preact"] as const) for (const hand of [false, true, "wrapped"] as const) {
      const consumer = hand === "wrapped" ? `${target} wrapped` : hand ? `${target} hand-written` : target;
      for (const mode of ["mount", "hydrate"] as const) {
        it(`${consumer} ${mode} matches live in ${engine}: entries, $if and keyed $each columns, cells, notes and contexts`, async () => {
          const browser = await launchParityBrowser(browserType);
          try {
            const live = await browser.newPage();
            const converted = await browser.newPage();
            const errors: string[] = [];
            for (const page of [live, converted]) page.on("pageerror", (error) => errors.push(error.message));
            converted.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
            await openLive(live, "x-products");
            await openTarget(converted, target, mode, hand === "wrapped" ? "WrappedProducts" : hand ? "HandProducts" : "XProducts");
            assert.equal(await tables(live), `<table><caption>4 columns</caption><thead><tr><th scope="col">Name</th><th class="numeric" scope="col"><abbr title="Price in US dollars" slot="header">Price</abbr></th><th scope="col">N</th><th scope="col">P</th></tr></thead><tbody>` +
              `<tr><td>Desk lamp</td><td><span><b>Desk lamp:quiet:compact</b></span>49</td><td>Desk lamp</td><td>49</td></tr>` +
              `<tr><td>Notebook</td><td><span><b>Notebook:quiet:compact</b></span>6.5</td><td>Notebook</td><td>6.5</td></tr></tbody>` +
              `<tfoot><tr><td><i slot="note">kept</i></td><td>-</td><td>-</td><td>-</td></tr></tfoot></table>\ncolumns: Name,-,N,P`);
            const initial = await tables(live, undefined, hand);
            assert.equal(await tables(converted, initial, hand), initial);
            if (mode === "hydrate") assert.equal(await converted.evaluate(`window.serverCells.every((cell) => cell.isConnected)`), true);
            for (const button of ["toggle", "swap", "rename", "toggle"]) {
              // Cells of keyed columns move with their column: after `toggle`, the swapped columns are the fourth and fifth.
              await converted.evaluate(`window.before = Array.from(document.querySelectorAll("tbody tr:first-child td"))`);
              await Promise.all([live, converted].map((page) => page.locator(`button.${button}`).click()));
              const expected = await tables(live, undefined, hand);
              assert.equal(await tables(converted, expected, hand), expected, `after ${button}`);
              if (button === "swap") {
                assert.equal(await converted.evaluate(`(() => { const after = Array.from(document.querySelectorAll("tbody tr:first-child td")); return window.before[3] === after[4] && window.before[4] === after[3] && window.before[0] === after[0]; })()`), true);
              }
            }
            assert.deepEqual(errors, []);
          } finally { await browser.close(); }
        });
      }

      if (hand !== "wrapped") it(`${consumer} warns like live for children a slot does not accept, presets and plain content for a slot with props in ${engine}`, async () => {
        const browser = await launchParityBrowser(browserType);
        try {
          const live = await browser.newPage();
          const converted = await browser.newPage();
          const warned = [await openLive(live, "x-warned"), await openTarget(converted, target, "mount", hand ? "HandWarned" : "XWarned")];
          const expected = await tables(live, undefined, hand);
          assert.equal(await tables(converted, expected, hand), expected);
          // The same messages; each names its own definition file.
          const [native, generated] = warned.map((messages) => [...new Set(messages.filter((message) => message.includes("HR007"))
            .map((message) => message.replace(/^.*HR007: /, "")))].sort());
          assert.equal(native!.length, 4);
          assert.deepEqual(generated, native);
          assert.ok(warned[1]!.filter((message) => message.includes("HR007")).every((message) => message.startsWith("HR007: ")), warned[1]!.join("\n"));
        } finally { await browser.close(); }
      });

      for (const mode of ["mount", "hydrate"] as const) {
        it(`${consumer} ${mode} matches live in ${engine}: $match and <template> regions, templates at every outlet, static outlet props and defaults`, async () => {
          const browser = await launchParityBrowser(browserType);
          try {
            const live = await browser.newPage();
            const converted = await browser.newPage();
            const errors: string[] = [];
            for (const page of [live, converted]) page.on("pageerror", (error) => errors.push(error.message));
            const warned = [await openLive(live, "x-more"), await openTarget(converted, target, mode, hand === "wrapped" ? "WrappedMore" : hand ? "HandMore" : "XMore")];
            const initial = await tables(live);
            assert.equal(initial, `<table><caption>3 columns</caption><thead><tr><th scope="col">Narrow</th><th scope="col">p</th><th scope="col">q</th></tr></thead>` +
              `<tbody><tr><td>A</td><td><b>p:quiet:compact</b></td><td><b>q:quiet:compact</b></td></tr></tbody>` +
              `<tfoot><tr><td><u>n</u><u>n</u></td><td>-<em>4px</em></td><td>-<em>4px</em></td></tr></tfoot></table>\ncolumns: Narrow,p,q`);
            assert.equal(await tables(converted, initial, hand), initial);
            for (const button of ["widen", "retag", "widen"]) {
              await Promise.all([live, converted].map((page) => page.locator(`button.${button}`).click()));
              const expected = await tables(live, undefined, hand);
              assert.equal(await tables(converted, expected, hand), expected, `after ${button}`);
            }
            const [native, generated] = warned.map((messages) => [...new Set(messages.filter((message) => message.includes("HR007")))].sort());
            // Without a public root URL the generated definitions have no file, so warnings start at the code.
            assert.ok(generated!.length === 2 && generated!.every((message) => message.startsWith("HR007: ")), generated!.join("\n"));
            assert.deepEqual(generated!.map((message) => message.replace(/^.*HR007: /, "")), native!.map((message) => message.replace(/^.*HR007: /, "")));
            assert.deepEqual(errors, []);
          } finally { await browser.close(); }
        });
      }
    }

    for (const target of ["react", "preact"] as const) for (const mode of ["mount", "hydrate"] as const) {
      /** What the table shows: its caption, header, first row's cells, footer and its controller's list. */
      const shape = (page: Page) => page.evaluate(`(() => { const table = document.querySelector("table"); const texts = (selector) => Array.from(table.querySelectorAll(selector), (cell) => cell.textContent.trim());
        return { caption: table.caption.textContent, head: texts("thead th"), row: texts("tbody tr:first-child td"), foot: texts("tfoot td"), columns: table.getAttribute("data-columns") }; })()`) as Promise<Record<string, unknown>>;
      const until = async (page: Page, expected: Record<string, unknown>, label: string) => {
        const deadline = Date.now() + 3_000;
        let actual = await shape(page);
        while (JSON.stringify(actual) !== JSON.stringify(expected) && Date.now() < deadline) { await settle(page); actual = await shape(page); }
        assert.deepEqual(actual, expected, label);
      };

      it(`${target} ${mode} in ${engine}: a wrapper's own state adds, removes, reorders and renames its columns among direct ones`, async () => {
        const browser = await launchParityBrowser(browserType);
        try {
          const page = await browser.newPage();
          const errors: string[] = [];
          page.on("pageerror", (error) => errors.push(error.message));
          page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
          const warnings = await openTarget(page, target, mode, "WrappedOwnState");
          const expected = (head: string[], row: string[], note = "direct"): Record<string, unknown> => ({ caption: head.length + " columns", head, row,
            foot: head.map((header) => header === "Direct" ? note : header === "Last" ? "kept" : "-"), columns: head.join(",") });
          const last = "A:quiet:compact";
          await until(page, expected(["Direct", "B", "C", "Last"], ["A", "2", "1", last]), "first");
          if (mode === "hydrate") assert.equal(await page.evaluate(`window.serverCells.every((cell) => cell.isConnected)`), true);
          await page.evaluate(`window.pair({ label: "Z" })`);
          await until(page, expected(["Direct", "Z", "C", "Last"], ["A", "2", "1", last]), "a prop in a wrapper reaches the entry");
          await page.evaluate(`window.pair({ field: "name" })`);
          await until(page, expected(["Direct", "Z", "C", "Last"], ["A", "A", "1", last]), "a prop in a wrapper reaches the cells");
          await page.evaluate(`Array.from(document.querySelectorAll("tbody td"), (cell) => { cell.dataset.was = cell.textContent.trim(); })`);
          await page.evaluate(`window.pair({ flip: true })`);
          await until(page, expected(["Direct", "C", "Z", "Last"], ["A", "1", "A", last]), "a keyed move in a wrapper");
          assert.deepEqual(await page.evaluate(`Array.from(document.querySelectorAll("tbody td"), (cell) => cell.dataset.was)`), ["A", "1", "A", last], "cells move with their column");
          await page.evaluate(`window.pair({ more: true })`);
          await until(page, expected(["Direct", "C", "M", "Z", "Last"], ["A", "1", "A", "A", last]), "a column added in a wrapper");
          await page.evaluate(`window.pair({ off: true })`);
          await until(page, expected(["Direct", "Last"], ["A", last]), "a wrapper's columns removed");
          await page.locator("button.note").click();
          await until(page, expected(["Direct", "Last"], ["A", last], "-"), "a consumer's update");
          await page.locator("button.last").click();
          await until(page, { caption: "1 columns", head: ["Direct"], row: ["A"], foot: ["-"], columns: "Direct" }, "the consumer removes a wrapper");
          await page.locator("button.last").click();
          await page.evaluate(`window.pair({ off: false, more: false, flip: false })`);
          await until(page, expected(["Direct", "Z", "C", "Last"], ["A", "A", "1", last], "-"), "all back in document order");
          assert.deepEqual(errors, []);
          assert.deepEqual(warnings.filter((message) => message.includes("left out")), [], "an unaccepted component renders with no warning");
        } finally { await browser.close(); }
      });

      it(`${target} ${mode} in ${engine}: a read before the outlet holds the direct columns in server output, then every column and its latest slot content`, async () => {
        const browser = await launchParityBrowser(browserType);
        try {
          const page = await browser.newPage();
          const errors: string[] = [];
          page.on("pageerror", (error) => errors.push(error.message));
          page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
          await openTarget(page, target, mode, "WrappedFirst");
          const notes = async (expected: string[]) => {
            const read = `JSON.stringify(Array.from(document.querySelectorAll("section p"), (note) => note.textContent))`;
            await page.waitForFunction(`${read} === ${JSON.stringify(JSON.stringify(expected))}`, undefined, { timeout: 3_000 }).catch(() => {});
            assert.deepEqual(JSON.parse(await page.evaluate(read) as string), expected);
          };
          await notes(["D", "N0"]);
          await page.locator("button.count").click();
          await notes(["D", "N1"]);
          assert.deepEqual(errors, []);
        } finally { await browser.close(); }
      });

      if (target === "react") {
        it(`react ${mode} in ${engine}: StrictMode keeps one entry per wrapped column`, async () => {
          const browser = await launchParityBrowser(browserType);
          try {
            const live = await browser.newPage();
            const page = await browser.newPage();
            const errors: string[] = [];
            page.on("pageerror", (error) => errors.push(error.message));
            page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
            await openLive(live, "x-products");
            await openTarget(page, target, mode, "StrictProducts");
            const initial = await tables(live, undefined, true);
            assert.equal(await tables(page, initial, true), initial);
            for (const button of ["toggle", "swap", "rename", "toggle"]) {
              await Promise.all([live, page].map((each) => each.locator(`button.${button}`).click()));
              const expected = await tables(live, undefined, true);
              assert.equal(await tables(page, expected, true), expected, `after ${button}`);
            }
            assert.deepEqual(errors, []);
          } finally { await browser.close(); }
        });

        if (mode === "hydrate") it(`react in ${engine}: a discarded concurrent render leaves no entry`, async () => {
          const browser = await launchParityBrowser(browserType);
          try {
            const page = await browser.newPage();
            await openTarget(page, target, mode, "Discarded");
            const expected = { caption: "2 columns", head: ["Direct", "Price"], row: ["A", "2"], foot: ["-", "-"], columns: "Direct,Price" };
            await until(page, expected, "first");
            await page.locator("button.pending").click();
            await settle(page);
            await until(page, expected, "the suspended transition commits nothing");
            await page.locator("button.urgent").click();
            await until(page, { ...expected, row: ["B", "3"] }, "an update while the transition waits holds the committed columns");
          } finally { await browser.close(); }
        });
      }
    }
  }

  it("serves wrapped columns in document order: content after the outlet reads them all, and a read before it reads the direct ones", () => {
    for (const target of ["react", "preact"] as const) {
      const html = servers.get(`${target}:WrappedOwnState`)!;
      const cells = (part: string) => [...html.match(new RegExp(`<${part}[ >][\\s\\S]*?</${part}>`))![0].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)].map((cell) => cell[1]!.replace(/<[^>]+>/g, ""));
      assert.deepEqual(cells("thead"), ["Direct", "B", "C", "Last"], target);
      assert.deepEqual(cells("tbody"), ["A", "2", "1", "A:quiet:compact"], target);
      assert.deepEqual(cells("tfoot"), ["direct", "-", "-", "kept"], target);
      assert.match(html.replace(/<!--[\s\S]*?-->/g, ""), /<caption>1 columns<\/caption>/, target);
      assert.match(servers.get(`${target}:WrappedFirst`)!.replace(/<!--[\s\S]*?-->/g, ""), /<section[^>]*><p[^>]*>D<\/p><table/, target);
    }
  });
});
