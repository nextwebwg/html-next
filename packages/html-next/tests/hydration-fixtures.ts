/** Components and cases rendered by Node and hydrated in a browser, by the live runtime and by compiled modules. */
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

import { generateComponent } from "../src/generate.js";
import { parseComponent } from "../src/source-parser.js";
import type { ComponentDefinition } from "../src/template.js";

import { formattingSource } from "./formatting-fixture.js";

export const definitions = [
  formattingSource,
  `<template component="ssr-inline"><defs>
    <state name="count" type="number" value="0"></state>
    <handler name="increment"><set name="count" expr:value="$count + 1"></set></handler>
    </defs><section><button type="button" on:click="increment">Next</button><p>Total: {$count} due today <b>Kept</b>!</p></section></template>`,
  `<template component="ssr-counter"><defs>
    <prop name="label" type="string" default="Visits">Label.</prop>
    <state name="count" type="number" value="0"></state>
    <state name="open" type="boolean" value="false"></state>
    <handler name="increment"><set name="count" expr:value="$count + 1"></set><set name="open" expr:value="true"></set></handler>
    </defs><section from:data-label="$label"><button type="button" on:click="increment"><span $value="$count"></span></button>
    <header><slot name="title">Untitled</slot></header><p>Hello <slot></slot>!</p>
    <aside $if="$open"><slot name="extra">Fallback</slot></aside></section></template>`,
  `<template component="ssr-list"><defs>
    <state name="rows" type="list(string)" value="['Ada']"></state>
    <handler name="change"><set name="rows" expr:value="['Bea', 'Ada', 'Cy']"></set></handler>
    </defs><section><button type="button" on:click="change">Change</button>
    <ul><li $each="row of $rows" $key="$row"><b $value="$row"></b></li></ul></section></template>`,
  `<template component="ssr-reader"><defs><context name="current" from="ssr-provider"></context></defs>
    <output $value="$current"></output></template>`,
  `<template component="ssr-bound-button"><defs><prop name="count" type="number" default="0">Count</prop></defs>
    <template $match><button $when="$count < 6" type="button"><slot></slot><span $value="$count"></span></button>
    <a $else href="#kept"><slot></slot><span $value="$count"></span></a></template></template>`,
  `<template component="ssr-bound-parent"><defs><state name="count" type="number" value="0"></state>
    <handler name="increment"><set name="count" expr:value="$count + 1"></set></handler></defs>
    <section><ssr-bound-button $ref="action" from:count="$count" from:aria-expanded="$count > 4"
    class:active="$count > 4" style:opacity="$count > 4 ? '0.5' : '1'" on:click="increment"><strong>Next</strong></ssr-bound-button></section></template>`,
  `<template component="ssr-provider"><defs><state name="current" type="number" value="1"></state>
    <handler name="increment"><set name="current" expr:value="$current + 1"></set></handler></defs>
    <section><button type="button" on:click="increment">Next</button><ssr-reader></ssr-reader><slot></slot></section></template>`,
  `<template component="ssr-control"><defs><state name="text" type="string" value="'initial'"></state></defs>
    <input bind:value="text" value="authored"></template>`,
  `<template component="ssr-delegate"><ssr-counter><slot></slot></ssr-counter></template>`,
  `<template component="ssr-props"><defs>
    <prop name="items" type="list(string)" default="[]">Items.</prop>
    <prop name="amount" type="number" default="2">Amount.</prop>
    <prop name="enabled" type="boolean" default="false">Enabled.</prop>
    </defs><output from:data-items="$items" $value="$amount"></output></template>`,
  `<template component="ssr-alias"><defs>
    <state name="first" type="unknown" value="{ count: 1 }"></state>
    <state name="second" type="unknown" value="first"></state>
    <handler name="increment"><set name="first.count" expr:value="$first.count + 1"></set></handler>
    </defs><section><button type="button" on:click="increment">Next</button><output $value="$second.count"></output></section></template>`,
  `<template component="ssr-match"><defs><state name="open" type="boolean" value="false"></state>
    <handler name="toggle"><set name="open" expr:value="not $open"></set></handler></defs>
    <template $match><article $when="$open"><button type="button" on:click="toggle">Close</button><slot></slot></article>
    <div $else><button type="button" on:click="toggle">Open</button><slot></slot></div></template></template>`,
  `<template component="ssr-table"><table><tbody><tr><td>Cell <slot></slot> end</td></tr></tbody></table></template>`,
  `<template component="ssr-classed"><defs><state name="count" type="number" value="0"></state></defs>
    <section class="card own" style="color: red" title="own"><output $value="$count"></output></section></template>`,
  `<template component="ssr-scoped"><defs>
    <state name="rows" type="list(string)" value="['Ada']"></state>
    <handler name="change"><set name="rows" expr:value="['Bea', 'Ada', 'Cy']"></set></handler>
    </defs><section><button type="button" on:click="change">Change</button><ul>
    <slot $each="row of $rows" $key="$row" name="row" from:item="$row"><li $value="$row"></li></slot>
    </ul></section></template>`,
  `<template component="ssr-scoped-page"><article><ssr-scoped><template slot="row"><li><b $value="$item"></b></li></template></ssr-scoped></article></template>`,
  `<template component="ssr-assorted"><defs>
    <state name="markup" type="string" value="<em>first</em>"></state>
    <state name="choice" type="string" value="b"></state>
    <state name="pairs" type="list(string)" value="['x', 'y']"></state>
    <state name="detail" type="object({ label: string })" value="{ label: 'kept' }"></state>
    <handler name="change"><set name="markup" expr:value="'<em>second</em>'"></set><set name="choice" expr:value="'a'"></set>
    <set name="pairs" expr:value="['y', 'z', 'x']"></set><set name="detail.label" expr:value="'changed'"></set></handler>
    </defs><section><button type="button" on:click="change">Change</button><div $html="$markup"></div><p><template $html="$markup"></template></p>
    <select bind:value="choice"><option value="a">A</option><option value="b">B</option></select>
    <dl><template $each="pair of $pairs" $key="$pair"><dt $value="$pair"></dt><dd>{$pair}!</dd></template></dl>
    <p $with="$detail as shown"><span $value="$shown.label"></span></p></section></template>`,
  `<template component="ssr-lazy-toggle"><defs><state name="open" type="boolean" value="false"></state>
    <handler name="toggle"><set name="open" expr:value="not $open"></set></handler></defs>
    <section><button type="button" on:click="toggle">More</button><div $if="$open"><slot name="details"></slot></div></section></template>`,
  `<template component="ssr-lazy-page"><defs><state name="label" type="string" value="first"></state></defs>
    <article><ssr-lazy-toggle><template slot="details"><img alt="" src="https://assets.example/lazy.png"><b $value="$label"></b></template></ssr-lazy-toggle></article></template>`,
].map((source) => parseComponent(source));

export const cases = [
  { name: "Intl text expressions and inferred declared types", html: '<x-formatting id="subject"></x-formatting>', state: {} },
  { name: "braced inline expressions with adjacent text and elements", html: '<ssr-inline id="subject"></ssr-inline>', state: { count: 7 } },
  { name: "changed state, implicit props, adjacent text and unrendered slots", html: '<ssr-counter id="subject"><b slot="title">T</b>world<i slot="extra">Hidden</i></ssr-counter>', state: { count: 7 } },
  { name: "keyed lists and retained row identity", html: '<ssr-list id="subject"></ssr-list>', state: { rows: ["Ada", "Bea"] } },
  { name: "nested components and shared state", html: '<ssr-provider id="subject"><strong>Projected</strong></ssr-provider>', state: { current: 5 } },
  { name: "parent bindings and events on nested native roots", html: '<ssr-bound-parent id="subject"></ssr-bound-parent>', state: { count: 5 } },
  { name: "parent bindings on nested native roots adopted in an earlier pass", html: '<ssr-bound-parent id="subject"></ssr-bound-parent>', state: { count: 5 }, earlierPass: "ssr-bound-button" },
  { name: "native form controls and edits before hydration", html: '<ssr-control id="subject"></ssr-control>', state: { text: "server" } },
  { name: "delegated roots and slot passthrough", html: '<ssr-delegate id="subject">Delegated</ssr-delegate>', state: {} },
  { name: "structured, boolean and rejected prop inputs", html: '<ssr-props id="subject" enabled items="[&quot;&lt;/script&gt;&amp;&quot;]" amount="invalid"></ssr-props>', state: {} },
  { name: "shared object state after nested writes", html: '<ssr-alias id="subject"></ssr-alias>', state: {} },
  { name: "state-selected native roots", html: '<ssr-match id="subject">Content</ssr-match>', state: { open: true } },
  { name: "slot ranges inside tables", html: '<ssr-table id="subject">Projected</ssr-table>', state: {} },
  { name: "a root's consumer class, style and attribute overrides", html: '<ssr-classed id="subject" class="mine" style="margin: 1px" title="theirs"></ssr-classed>', state: { count: 3 } },
  { name: "scoped slots and keyed projection", html: '<ssr-scoped id="subject"><template slot="row"><li><b $value="$item"></b></li></template></ssr-scoped>', state: { rows: ["Ada", "Bea"] } },
  { name: "a consumer component's scoped template and keyed projection", html: '<ssr-scoped-page id="subject"></ssr-scoped-page>', state: {} },
  { name: "$html, a bound select, rows of several nodes and $with", html: '<ssr-assorted id="subject"></ssr-assorted>', state: { choice: "a", pairs: ["y", "x"] } },
  { name: "a closed slot's lazy consumer template", html: '<ssr-lazy-page id="subject"></ssr-lazy-page>', state: { label: "server" } },
] as const;

/**
 * Components compiled for hydration (`create<Name>(options, html, root)` adopts a server root), each with
 * the others as its invocations, bundled behind an entry exporting `factories` by tag and `more`.
 * `files` supplies the modules they import by specifier, such as controllers.
 */
export async function compiledFixtures(format: "esm" | "iife", more = "", components: readonly ComponentDefinition[] = definitions,
  files: Readonly<Record<string, string>> = {}): Promise<string> {
  const source = fileURLToPath(new URL("../src/", import.meta.url));
  const invocations = new Map(components.map((definition) =>
    [definition.contract.tag, { module: `./${definition.contract.name}.js`, definition }]));
  const modules = new Map(components.map((definition) => [`./${definition.contract.name}.js`,
    generateComponent(definition, { invocations, hydrate: true }).find((artifact) => artifact.path === `vanilla/${definition.contract.name}.js`)!.content]));
  for (const [specifier, contents] of Object.entries(files)) modules.set(specifier, contents);
  const entry = [
    ...components.map((definition) => `import { create${definition.contract.name} } from "./${definition.contract.name}.js";`),
    `export const factories = { ${components.map((definition) => `${JSON.stringify(definition.contract.tag)}: create${definition.contract.name}`).join(", ")} };`,
    more,
  ].join("\n");
  const result = await build({
    stdin: { contents: entry, loader: "js", resolveDir: source },
    bundle: true, format, globalName: "HtmlCompiled", write: false, platform: "browser", target: ["es2022"],
    // A classic script has no module URL; the document's stands in for it.
    ...format === "iife" ? { define: { "import.meta.url": "document.baseURI" } } : {},
    alias: {
      "@nextwebwg/html-next/generated-runtime": `${source}generated-runtime.ts`,
      "@nextwebwg/html-next/runtime": `${source}runtime.ts`,
    },
    plugins: [{ name: "generated", setup(builder) {
      builder.onResolve({ filter: /\.css$/ }, (args) => ({ path: args.path, namespace: "styles" }));
      builder.onLoad({ filter: /.*/, namespace: "styles" }, () => ({ contents: "", loader: "js" }));
      builder.onResolve({ filter: /^\.\/[\w-]+\.js$/ }, (args) => modules.has(args.path) ? { path: args.path, namespace: "generated" } : undefined);
      builder.onLoad({ filter: /.*/, namespace: "generated" }, (args) => ({ contents: modules.get(args.path)!, loader: "js", resolveDir: source }));
    } }],
  });
  return result.outputFiles[0]!.text;
}
