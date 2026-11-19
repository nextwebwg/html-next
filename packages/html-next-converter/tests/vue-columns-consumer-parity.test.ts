import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";

import { compileScript, compileTemplate, parse as parseVue, type SFCDescriptor } from "@vue/compiler-sfc";
import { build, type BuildOptions } from "esbuild";
import { chromium, firefox, webkit, type BrowserType, type Page } from "playwright";

import { convertComponents } from "../src/index.js";
import { launchParityBrowser } from "../../html-next/tests/pixel-parity.js";

/**
 * Columns as markup (https://nextwebwg.org/declarative-components/components#columns-as-markup) with
 * hand-written Vue consumers: an SFC template and an `h()` render function give a converted table
 * the same columns a converted HTML Next consumer does, and get the same table, `$columns` list,
 * slot content, context, takeover, warnings and cell identity, mounted and hydrated.
 */
const enabled = process.env.HTMLNEXT_TARGET_TEST === "1";
const nodeModules = new URL("../node_modules", import.meta.url).pathname;
// The server renderer is a dependency of the html-next package's own tests.
const serverModules = new URL("../../html-next/node_modules", import.meta.url).pathname;

const source = `<template component="x-column" status="early" summary="Column."><th $attributes scope="col"><slot name="header">{$header}</slot></th>
  <defs><prop name="field" type="string">Field.</prop><prop name="header" type="string">Header.</prop>
    <prop name="span" type="number" default="1">Span.</prop>
    <state name="tone" type="string" value="quiet"></state>
    <slot name="header"></slot><slot name="note"></slot><slot name="cell"><prop name="row" type="object" required>Row.</prop></slot></defs></template>
<template component="x-datatable" status="early" summary="Table." controller="./table.js"><defs>
    <prop name="rows" type="list(object({ id: number, name: string, price: number }))" required>Rows.</prop>
    <prop name="lead" type="boolean" default="true">Lead.</prop>
    <state name="density" type="string" value="compact"></state>
    <slot accepts="x-column" as="columns"></slot></defs>
  <table><caption>{$columns.length} columns</caption><thead><tr><template $slot></template></tr></thead>
    <tbody><tr $each="row of $rows" $key="$row.id"><td $each="column of $columns" $key="$column">
      <slot of="$column" name="cell" from:row="$row">{$row[$column.field]}</slot></td></tr></tbody>
    <tfoot><tr><td $each="column of $columns" $key="$column"><template $if="$lead"><slot of="$column" name="note">-</slot></template><slot of="$column" name="note"></slot></td></tr></tfoot></table></template>
<template component="x-first" status="early" summary="Reads its list before its outlet."><defs><slot accepts="x-column" as="columns"></slot></defs>
  <section><p $each="column of $columns" $key="$column"><slot of="$column" name="note">{$column.header}</slot></p><table><thead><tr><template $slot></template></tr></thead></table></section></template>
<template component="x-badge" status="early" summary="Badge."><defs><prop name="text" type="string">Text.</prop>
    <context name="tone" from="x-column"></context><context name="density" from="x-datatable"></context></defs>
  <b>{$text}:{$tone}:{$density}</b></template>
<template component="x-app" status="early" summary="App."><defs>
    <state name="products" type="list(object({ id: number, name: string, price: number }))"
      value="[{ id: 1, name: 'Desk lamp', price: 49 }, { id: 2, name: 'Notebook', price: 6.5 }]"></state>
    <state name="showId" type="boolean" value="false"></state>
    <state name="label" type="string" value="Name"></state>
    <state name="extra" type="list(object({ key: string, label: string }))" value="[{ key: 'name', label: 'N' }, { key: 'price', label: 'P' }, { key: 'id', label: 'I' }]"></state>
    <state name="lead" type="boolean" value="true"></state>
    <state name="warned" type="boolean" value="false"></state>
    <handler name="toggle"><set name="showId" expr:value="not $showId"></set></handler>
    <handler name="rename"><set name="label" expr:value="'Product'"></set></handler>
    <handler name="swap"><set name="extra" expr:value="[{ key: 'id', label: 'I' }, { key: 'price', label: 'P' }, { key: 'name', label: 'N' }]"></set></handler>
    <handler name="drop"><set name="extra" expr:value="[{ key: 'id', label: 'I' }, { key: 'name', label: 'N' }]"></set></handler>
    <handler name="add"><set name="products" expr:value="[{ id: 1, name: 'Desk lamp', price: 49 }, { id: 2, name: 'Notebook', price: 6.5 }, { id: 3, name: 'Pen', price: 2 }]"></set></handler>
    <handler name="unlead"><set name="lead" expr:value="false"></set></handler>
    <handler name="warn"><set name="warned" expr:value="true"></set></handler></defs>
  <main><button type="button" class="toggle" on:click="toggle">Id</button><button type="button" class="rename" on:click="rename">Rename</button>
    <button type="button" class="swap" on:click="swap">Swap</button><button type="button" class="drop" on:click="drop">Drop</button>
    <button type="button" class="add" on:click="add">Add</button><button type="button" class="unlead" on:click="unlead">Unlead</button>
    <button type="button" class="warn" on:click="warn">Warn</button>
    <x-datatable from:rows="$products" from:lead="$lead">
      <x-column $if="$showId" field="id" header="Id"></x-column>
      <x-column field="name" from:header="$label"><i slot="note">kept</i></x-column>
      <x-column class="numeric" span="2">
        <abbr slot="header" title="Price in US dollars">Price</abbr>
        <template slot="cell"><x-badge from:text="$row.name"></x-badge>{$row.price}</template>
      </x-column>
      <x-column $each="column of $extra" $key="$column.key" from:field="$column.key" from:header="$column.label"></x-column>
    </x-datatable>
    <x-datatable from:rows="[{ id: 1, name: 'A', price: 1 }]">
      <template $if="$showId"><x-column field="id" header="T"></x-column></template>
      <template $each="column of $extra" $key="$column.key"><x-column from:field="$column.key" from:header="$column.label"></x-column></template>
    </x-datatable>
    <x-datatable $if="$warned" from:rows="[{ id: 1, name: 'A', price: 1 }]"><x-column field="name"></x-column>stray<b>x</b></x-datatable></main></template>`;
/** Reads the table's \`as\` list from its controller. */
const controller = `export default function initialize(host) {
  return host.effect(() => host.root.setAttribute("data-columns", host.state.columns.map((column) => (column.header ?? column.field ?? "-") + ":" + column.span).join(",")));
}`;

/** The same app as an SFC template, the way a Vue application writes one. */
const sfcConsumer = `<script setup lang="ts">
import { ref } from "vue";
import XDatatable from "./XDatatable.vue";
import XColumn from "./XColumn.vue";
import XBadge from "./XBadge.vue";
const products = ref([{ id: 1, name: "Desk lamp", price: 49 }, { id: 2, name: "Notebook", price: 6.5 }]);
const showId = ref(false);
const label = ref("Name");
const extra = ref([{ key: "name", label: "N" }, { key: "price", label: "P" }, { key: "id", label: "I" }]);
const lead = ref(true);
const warned = ref(false);
const add = () => { products.value = [...products.value, { id: 3, name: "Pen", price: 2 }]; };
</script>
<template>
  <main>
    <button type="button" class="toggle" @click="showId = !showId">Id</button>
    <button type="button" class="rename" @click="label = 'Product'">Rename</button>
    <button type="button" class="swap" @click="extra = [extra[2]!, extra[1]!, extra[0]!]">Swap</button>
    <button type="button" class="drop" @click="extra = extra.filter((column) => column.key !== 'price')">Drop</button>
    <button type="button" class="add" @click="add">Add</button>
    <button type="button" class="unlead" @click="lead = false">Unlead</button>
    <button type="button" class="warn" @click="warned = true">Warn</button>
    <XDatatable :rows="products" :lead="lead">
      <XColumn v-if="showId" field="id" header="Id" />
      <XColumn field="name" :header="label"><template #note><i>kept</i></template></XColumn>
      <XColumn class="numeric" :span="2">
        <template #header><abbr title="Price in US dollars">Price</abbr></template>
        <template #cell="{ row }"><XBadge :text="row.name" />{{ row.price }}</template>
      </XColumn>
      <XColumn v-for="column in extra" :key="column.key" :field="column.key" :header="column.label" />
    </XDatatable>
    <XDatatable :rows="[{ id: 1, name: 'A', price: 1 }]">
      <template v-if="showId"><XColumn field="id" header="T" /></template>
      <template v-for="column in extra" :key="column.key"><XColumn :field="column.key" :header="column.label" /></template>
    </XDatatable>
    <XDatatable v-if="warned" :rows="[{ id: 1, name: 'A', price: 1 }]"><XColumn field="name" />stray<b>x</b></XDatatable>
  </main>
</template>
`;

/** The same app as a render function. */
const renderConsumer = `import { defineComponent, Fragment, h, ref } from "vue";
import XDatatable from "./XDatatable.vue";
import XColumn from "./XColumn.vue";
import XBadge from "./XBadge.vue";
export default defineComponent({ setup() {
  const products = ref([{ id: 1, name: "Desk lamp", price: 49 }, { id: 2, name: "Notebook", price: 6.5 }]);
  const showId = ref(false);
  const label = ref("Name");
  const extra = ref([{ key: "name", label: "N" }, { key: "price", label: "P" }, { key: "id", label: "I" }]);
  const lead = ref(true);
  const warned = ref(false);
  const button = (name: string, text: string, onClick: () => void) => h("button", { type: "button", class: name, onClick }, text);
  return () => {
    // Values read outside the slot function: the table follows them as the consumer re-renders.
    const header = label.value;
    const columns = extra.value.map((column) => h(XColumn, { key: column.key, field: column.key, header: column.label }));
    return h("main", [
      button("toggle", "Id", () => { showId.value = !showId.value; }),
      button("rename", "Rename", () => { label.value = "Product"; }),
      button("swap", "Swap", () => { extra.value = [extra.value[2]!, extra.value[1]!, extra.value[0]!]; }),
      button("drop", "Drop", () => { extra.value = extra.value.filter((column) => column.key !== "price"); }),
      button("add", "Add", () => { products.value = [...products.value, { id: 3, name: "Pen", price: 2 }]; }),
      button("unlead", "Unlead", () => { lead.value = false; }),
      button("warn", "Warn", () => { warned.value = true; }),
      h(XDatatable, { rows: products.value, lead: lead.value }, () => [
        showId.value ? h(XColumn, { field: "id", header: "Id" }) : null,
        h(XColumn, { field: "name", header }, { note: () => h("i", "kept") }),
        h(XColumn, { class: "numeric", span: 2 }, {
          header: () => h("abbr", { title: "Price in US dollars" }, "Price"),
          cell: ({ row }: { row: { name: string; price: number } }) => [h(XBadge, { text: row.name }), String(row.price)],
        }),
        ...columns,
      ]),
      h(XDatatable, { rows: [{ id: 1, name: "A", price: 1 }] }, () => [
        showId.value ? [h(XColumn, { field: "id", header: "T" })] : [],
        extra.value.map((column) => h(XColumn, { key: column.key, field: column.key, header: column.label })),
      ]),
      warned.value ? h(XDatatable, { rows: [{ id: 1, name: "A", price: 1 }] }, () => [h(XColumn, { field: "name" }), h(Fragment, null, ["stray"]), h("b", "x")]) : null,
    ]);
  };
} });
`;

/** The same app with its columns in components of its own: a condition inside one, keyed ones, and direct ones between them. */
const wrappers = {
  "IdColumn.vue": `<script setup lang="ts">
import XColumn from "./XColumn.vue";
defineProps<{ show: boolean; header: string }>();
</script>
<template><XColumn v-if="show" field="id" :header="header" /></template>
`,
  "PriceColumn.vue": `<script setup lang="ts">
import XColumn from "./XColumn.vue";
import XBadge from "./XBadge.vue";
</script>
<template>
  <XColumn class="numeric" :span="2">
    <template #header><abbr title="Price in US dollars">Price</abbr></template>
    <template #cell="{ row }"><XBadge :text="row.name" />{{ row.price }}</template>
  </XColumn>
</template>
`,
  "ExtraColumn.vue": `<script setup lang="ts">
import XColumn from "./XColumn.vue";
defineProps<{ column: { key: string; label: string } }>();
</script>
<template><XColumn :field="column.key" :header="column.label" /></template>
`,
  // A wrapper whose own state changes its columns: nothing outside it re-renders.
  "PairColumns.vue": `<script setup lang="ts">
import { reactive, computed } from "vue";
import XColumn from "./XColumn.vue";
const state = reactive({ label: "B", field: "price", flip: false, more: false, off: false });
(globalThis as { pair?: unknown }).pair = (next: object) => { Object.assign(state, next); };
const columns = computed(() => {
  const list = [{ key: "b", field: state.field, header: state.label }, { key: "c", field: "id", header: "C" }];
  if (state.more) list.splice(1, 0, { key: "m", field: "name", header: "M" });
  return state.off ? [] : state.flip ? list.reverse() : list;
});
</script>
<template><XColumn v-for="column in columns" :key="column.key" :field="column.field" :header="column.header" /></template>
`,
  "NotAColumn.vue": `<script setup lang="ts">defineOptions({ inheritAttrs: false });</script>
<template><span v-if="false"></span></template>
`,
  "LastColumn.vue": `<script setup lang="ts">
import XColumn from "./XColumn.vue";
import XBadge from "./XBadge.vue";
</script>
<template>
  <XColumn header="Last">
    <template #cell="{ row }"><XBadge :text="row.name" /></template>
    <template #note><i>kept</i></template>
  </XColumn>
</template>
`,
  "NoteColumn.vue": `<script setup lang="ts">
import XColumn from "./XColumn.vue";
defineProps<{ count: number }>();
</script>
<template><XColumn header="H"><template #note><b>N{{ count }}</b></template></XColumn></template>
`,
  "First.vue": `<script setup lang="ts">
import { ref } from "vue";
import XFirst from "./XFirst.vue";
import XColumn from "./XColumn.vue";
import NoteColumn from "./NoteColumn.vue";
const count = ref(0);
</script>
<template>
  <main>
    <button type="button" class="count" @click="count++">Count</button>
    <XFirst><XColumn header="D" /><NoteColumn :count="count" /></XFirst>
  </main>
</template>
`,
  "OwnState.vue": `<script setup lang="ts">
import { ref } from "vue";
import XDatatable from "./XDatatable.vue";
import XColumn from "./XColumn.vue";
import PairColumns from "./PairColumns.vue";
import NotAColumn from "./NotAColumn.vue";
import LastColumn from "./LastColumn.vue";
const last = ref(true);
</script>
<template>
  <main>
    <button type="button" class="last" @click="last = !last">Last</button>
    <XDatatable :rows="[{ id: 1, name: 'A', price: 2 }]">
      <XColumn field="name" header="Direct" />
      <PairColumns />
      <NotAColumn />
      <LastColumn v-if="last" />
    </XDatatable>
  </main>
</template>
`,
} as const;
const wrappedSfcConsumer = sfcConsumer
  .replace(`import XBadge from "./XBadge.vue";`, `import IdColumn from "./IdColumn.vue";
import PriceColumn from "./PriceColumn.vue";
import ExtraColumn from "./ExtraColumn.vue";`)
  .replace(`      <XColumn v-if="showId" field="id" header="Id" />
      <XColumn field="name" :header="label"><template #note><i>kept</i></template></XColumn>
      <XColumn class="numeric" :span="2">
        <template #header><abbr title="Price in US dollars">Price</abbr></template>
        <template #cell="{ row }"><XBadge :text="row.name" />{{ row.price }}</template>
      </XColumn>
      <XColumn v-for="column in extra" :key="column.key" :field="column.key" :header="column.label" />`, `      <IdColumn :show="showId" header="Id" />
      <XColumn field="name" :header="label"><template #note><i>kept</i></template></XColumn>
      <PriceColumn />
      <ExtraColumn v-for="column in extra" :key="column.key" :column="column" />`)
  .replace(`      <template v-if="showId"><XColumn field="id" header="T" /></template>
      <template v-for="column in extra" :key="column.key"><XColumn :field="column.key" :header="column.label" /></template>`, `      <IdColumn :show="showId" header="T" />
      <template v-for="column in extra" :key="column.key"><XColumn :field="column.key" :header="column.label" /></template>`);

/** The same app with every column of its first table in a render-function wrapper. */
const wrappedRenderConsumer = renderConsumer
  .replace(`export default defineComponent({ setup() {`, `const IdColumn = defineComponent({ props: ["show", "header"], render() { return this.show ? h(XColumn, { field: "id", header: this.header }) : null; } });
const NameColumn = defineComponent({ props: ["header"], render() { return h(XColumn, { field: "name", header: this.header }, { note: () => h("i", "kept") }); } });
const PriceColumn = defineComponent({ render: () => h(XColumn, { class: "numeric", span: 2 }, {
  header: () => h("abbr", { title: "Price in US dollars" }, "Price"),
  cell: ({ row }: { row: { name: string; price: number } }) => [h(XBadge, { text: row.name }), String(row.price)],
}) });
const ExtraColumn = defineComponent({ props: ["column"], render() { return h(XColumn, { field: this.column.key, header: this.column.label }); } });
export default defineComponent({ setup() {`)
  .replace(`const columns = extra.value.map((column) => h(XColumn, { key: column.key, field: column.key, header: column.label }));`, `const columns = extra.value.map((column) => h(ExtraColumn, { key: column.key, column }));`)
  .replace(`        showId.value ? h(XColumn, { field: "id", header: "Id" }) : null,
        h(XColumn, { field: "name", header }, { note: () => h("i", "kept") }),
        h(XColumn, { class: "numeric", span: 2 }, {
          header: () => h("abbr", { title: "Price in US dollars" }, "Price"),
          cell: ({ row }: { row: { name: string; price: number } }) => [h(XBadge, { text: row.name }), String(row.price)],
        }),
        ...columns,`, `        h(IdColumn, { show: showId.value, header: "Id" }),
        h(NameColumn, { header }),
        h(PriceColumn),
        ...columns,`)
  .replace(`        showId.value ? [h(XColumn, { field: "id", header: "T" })] : [],`, `        h(IdColumn, { show: showId.value, header: "T" }),`);

/** Each table without marks, comments or runtime attributes, and the list its controller wrote. */
const READ = `Array.from(document.querySelectorAll("table"), (table) => {
  const read = (node) => {
    if (node.nodeType === 3) return node.data.trim();
    if (node.nodeType !== 1 || node.localName === "template") return "";
    const keep = ["class", "scope", "title"].filter((name) => node.hasAttribute(name)).map((name) => " " + name + '="' + node.getAttribute(name) + '"');
    return "<" + node.localName + keep.join("") + ">" + Array.from(node.childNodes, read).join("") + "</" + node.localName + ">";
  };
  return read(table) + " columns: " + table.closest("[data-columns]")?.getAttribute("data-columns");
})`;
const mark = `Array.from(document.querySelectorAll("table")[0].querySelectorAll("tbody tr:first-child td"), (cell, index) => { cell.dataset.was = String(index); }).length`;
const marks = `Array.from(document.querySelectorAll("table")[0].querySelectorAll("tbody tr:first-child td"), (cell) => cell.dataset.was ?? null)`;

const consumers = ["compiled", "sfc", "render", "wrappedSfc", "wrappedRender"] as const;
type Consumer = typeof consumers[number];

const sfc = (suffix: string) => ({ name: `compiled-vue-sfc${suffix}`, setup(pluginBuild: { onResolve: (options: { filter: RegExp }, callback: (args: { path: string; resolveDir: string }) => { path: string }) => void }) {
  pluginBuild.onResolve({ filter: /\.vue$/ }, (args) => ({ path: resolve(args.resolveDir, args.path.replace(/\.vue$/, `${suffix}.ts`)) }));
} });

/** Writes an SFC's browser module beside it as `.ts`, and its server module as `.ssr.ts`. */
async function compileSfc(file: string, id: string): Promise<void> {
  const parsed = parseVue(await readFile(file, "utf8"), { filename: file });
  assert.deepEqual(parsed.errors, [], file);
  const descriptor: SFCDescriptor = parsed.descriptor;
  await writeFile(file.replace(/\.vue$/, ".ts"), compileScript(descriptor, { id, inlineTemplate: true }).content);
  const script = compileScript(descriptor, { id });
  const template = compileTemplate({ source: descriptor.template!.content, filename: file, id, ssr: true, ssrCssVars: [],
    compilerOptions: { bindingMetadata: script.bindings ?? {} } });
  assert.deepEqual(template.errors, []);
  await writeFile(file.replace(/\.vue$/, ".ssr.ts"), `${script.content.replace("export default", "const Component =")}\n${template.code}\nexport default Object.assign(Component, { ssrRender });\n`);
}

async function tables(page: Page, expected?: readonly string[]): Promise<string[]> {
  if (expected !== undefined) {
    await page.waitForFunction(`JSON.stringify(${READ}) === ${JSON.stringify(JSON.stringify(expected))}`, undefined, { timeout: 5_000 }).catch(() => {});
  }
  return page.evaluate(READ) as Promise<string[]>;
}

describe.skipIf(!enabled)("columns from hand-written Vue consumers", () => {
  let directory = "";
  let fresh = "";
  let hydrate = "";
  let server: Record<Consumer | "ownState" | "first", string> = { compiled: "", sfc: "", render: "", wrappedSfc: "", wrappedRender: "", ownState: "", first: "" };

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-vue-columns-consumers-"));
    await symlink(nodeModules, join(directory, "node_modules"), "dir");
    const app = join(directory, "app");
    await mkdir(app);
    await writeFile(join(app, "columns.html"), source);
    await writeFile(join(app, "table.js"), controller);
    const manifest = await convertComponents({ mode: "application", target: "vue", root: app, outDirectory: join(app, "vue"), entries: ["columns.html"] });
    for (const component of manifest.components) await compileSfc(join(app, "vue", component.artifact), component.tag);
    // The hand-written consumers sit beside the converted components.
    const out = dirname(join(app, "vue", manifest.components[0]!.artifact));
    await writeFile(join(out, "Consumer.vue"), sfcConsumer);
    await compileSfc(join(out, "Consumer.vue"), "consumer");
    await writeFile(join(out, "render.ts"), renderConsumer);
    await writeFile(join(out, "WrappedConsumer.vue"), wrappedSfcConsumer);
    await compileSfc(join(out, "WrappedConsumer.vue"), "wrapped-consumer");
    await writeFile(join(out, "wrappedRender.ts"), wrappedRenderConsumer);
    for (const [name, content] of Object.entries(wrappers)) {
      await writeFile(join(out, name), content);
      await compileSfc(join(out, name), name.toLowerCase());
    }
    // vue-tsc checks the hand-written consumers against the converted components, as an application's build does.
    await writeFile(join(out, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler",
      strict: true, skipLibCheck: true, noEmit: true, allowImportingTsExtensions: true, lib: ["ES2022", "DOM", "DOM.Iterable"] }, files: ["Consumer.vue", "render.ts", "WrappedConsumer.vue", "wrappedRender.ts", "OwnState.vue", "First.vue"] }));
    await new Promise<void>((done, fail) => execFile(join(nodeModules, ".bin/vue-tsc"), ["-p", join(out, "tsconfig.json")], { cwd: out },
      (error, stdout) => error === null ? done() : fail(new Error(stdout || String(error)))));
    const imports = `import Compiled from "./XApp.vue"; import Sfc from "./Consumer.vue"; import Render from "./render.ts";
import WrappedSfc from "./WrappedConsumer.vue"; import WrappedRender from "./wrappedRender.ts"; import OwnState from "./OwnState.vue"; import First from "./First.vue";
const apps = { compiled: Compiled, sfc: Sfc, render: Render, wrappedSfc: WrappedSfc, wrappedRender: WrappedRender, ownState: OwnState, first: First } as const;`;
    const options: BuildOptions = { bundle: true, format: "iife", platform: "browser", target: ["es2022"], nodePaths: [nodeModules], plugins: [sfc("")] };
    await writeFile(join(out, "entry.ts"), `import { createApp, h } from "vue"; ${imports}
createApp({ render: () => h(apps[(window as any).consumer as keyof typeof apps]) }).mount("#mount");`);
    await build({ ...options, entryPoints: [join(out, "entry.ts")], outfile: fresh = join(directory, "vue.js") });
    await writeFile(join(out, "hydrate.ts"), `import { createSSRApp, h } from "vue"; ${imports}
createSSRApp({ render: () => h(apps[(window as any).consumer as keyof typeof apps]) }).mount("#mount");`);
    await build({ ...options, entryPoints: [join(out, "hydrate.ts")], outfile: hydrate = join(directory, "hydrate.js") });
    await writeFile(join(out, "server.ts"), `import { createSSRApp, h } from "vue"; import { renderToString } from "@vue/server-renderer"; ${imports}
export const render = (name: keyof typeof apps) => renderToString(createSSRApp({ render: () => h(apps[name]) }));`);
    const serverBuild = await build({ entryPoints: [join(out, "server.ts")], bundle: true, format: "esm", platform: "node", write: false, nodePaths: [serverModules, nodeModules], plugins: [sfc(".ssr")] });
    const module = await import(`data:text/javascript;base64,${Buffer.from(serverBuild.outputFiles[0]!.text).toString("base64")}`) as { render(name: keyof typeof server): Promise<string> };
    for (const name of Object.keys(server) as (keyof typeof server)[]) server[name] = await module.render(name);
  }, 180_000);
  afterAll(async () => { if (directory !== "") await rm(directory, { recursive: true, force: true }); });

  it("renders the same server markup for each consumer", () => {
    // Each consumer's server tables are complete, and the same apart from hydration markers, the
    // whitespace between elements and the \`slot\` attribute a converted consumer keeps.
    const bare = (html: string) => html.replace(/<!--[\s\S]*?-->/g, "").replace(/>\s+</g, "><").replace(/ slot="[^"]*"/g, "")
      .match(/<table[\s\S]*?<\/table>/g)!.join("");
    assert.match(bare(server.compiled), /<caption>5 columns<\/caption>/);
    assert.match(bare(server.compiled), /<b[^>]*>Desk lamp:quiet:compact<\/b>49<\/td>/);
    assert.equal(bare(server.sfc), bare(server.compiled));
    assert.equal(bare(server.render), bare(server.compiled));
    // A wrapper's column reaches the list as the outlet renders it, so the caption before the outlet counts
    // the direct ones, and everything after the outlet reads them all, in document order.
    const uncounted = (html: string) => html.replace(/<caption>\d+ columns<\/caption>/g, "<caption></caption>");
    for (const [wrapped, direct] of [[server.wrappedSfc, "1 columns"], [server.wrappedRender, "0 columns"]] as const) {
      assert.equal(uncounted(bare(wrapped)), uncounted(bare(server.compiled)));
      assert.match(bare(wrapped), new RegExp(`^<table[^>]*><caption>${direct}</caption>`));
    }
    const own = bare(server.ownState);
    assert.match(own, /<caption>1 columns<\/caption>/);
    assert.match(server.first.replace(/<!--[\s\S]*?-->/g, "").replace(/>\s+</g, "><"), /<section[^>]*><p[^>]*>D<\/p><table/);
    assert.match(own, /<thead><tr><th[^>]*>Direct<\/th><th[^>]*>B<\/th><th[^>]*>C<\/th><th[^>]*>Last<\/th><\/tr>/);
    assert.match(own, /<tbody><tr><td[^>]*>A<\/td><td[^>]*>2<\/td><td[^>]*>1<\/td><td[^>]*><b[^>]*>A:quiet:compact<\/b><\/td><\/tr><\/tbody>/);
  });

  for (const [engine, browserType] of [["Chromium", chromium], ["Firefox", firefox], ["WebKit", webkit]] as const satisfies ReadonlyArray<readonly [string, BrowserType]>) {
    it(`${engine} renders, updates and hydrates each consumer's tables alike`, async () => {
      const browser = await launchParityBrowser(browserType);
      try {
        const errors: string[] = [];
        const warnings: Record<string, string[]> = {};
        const pages: Record<string, Page> = {};
        for (const consumer of consumers) {
          for (const mode of ["fresh", "hydrated"] as const) {
            const name = `${consumer} ${mode}`;
            const page = pages[name] = await browser.newPage();
            warnings[name] = [];
            page.on("pageerror", (error) => errors.push(`${name}: ${error.message}`));
            page.on("console", (message) => {
              if (message.type() === "error") errors.push(`${name}: ${message.text()}`);
              if (message.type() === "warning") warnings[name]!.push(message.text());
            });
            await page.setContent(`<div id="mount">${mode === "fresh" ? "" : server[consumer]}</div>`);
            if (mode === "hydrated") await page.evaluate(`window.serverCells = Array.from(document.querySelectorAll("td"))`);
            await page.evaluate(`window.consumer = ${JSON.stringify(consumer)}`);
            await page.addScriptTag({ path: mode === "fresh" ? fresh : hydrate });
          }
        }
        const reference = pages["compiled fresh"]!;
        const others = Object.entries(pages).filter(([, page]) => page !== reference);
        const same = async (label: string): Promise<void> => {
          const expected = await tables(reference);
          const actual = Object.fromEntries(await Promise.all(others.map(async ([name, page]) => [name, await tables(page, expected)] as const)));
          assert.deepEqual(actual, Object.fromEntries(others.map(([name]) => [name, expected])), label);
        };
        await same("first render");
        assert.equal((await tables(reference)).length, 2);
        const first = await tables(reference);
        assert.match(first[0]!, /^<table><caption>5 columns<\/caption><thead><tr><th scope="col">Name<\/th><th class="numeric" scope="col"><abbr title="Price in US dollars">Price<\/abbr><\/th>/);
        assert.match(first[0]!, /<tbody><tr><td>Desk lamp<\/td><td><b>Desk lamp:quiet:compact<\/b>49<\/td><td>Desk lamp<\/td><td>49<\/td><td>1<\/td><\/tr>/);
        assert.match(first[0]!, /<tfoot><tr><td><i>kept<\/i><\/td><td>-<\/td><td>-<\/td><td>-<\/td><td>-<\/td><\/tr><\/tfoot><\/table> columns: Name:1,-:2,N:1,P:1,I:1$/);
        for (const consumer of consumers) {
          assert.equal(await pages[`${consumer} hydrated`]!.evaluate(`window.serverCells.every((cell) => cell.isConnected)`), true, `${consumer} hydration kept the server's cells`);
        }

        const step = async (button: string, check: (table: string) => void, kept?: readonly (string | null)[]): Promise<void> => {
          for (const page of Object.values(pages)) await page.evaluate(mark);
          for (const page of Object.values(pages)) await page.locator(`button.${button}`).click();
          await reference.waitForTimeout(30);
          await same(button);
          check((await tables(reference))[0]!);
          // Cells keep their nodes as the columns change, as they do for the compiled consumer.
          const cells = await reference.evaluate(marks);
          if (kept !== undefined) assert.deepEqual(cells, kept, `${button} cells`);
          for (const [name, page] of others) assert.deepEqual(await page.evaluate(marks), cells, `${button}: ${name} cells`);
        };
        await step("toggle", (table) => assert.match(table, /^<table><caption>6 columns<\/caption><thead><tr><th scope="col">Id<\/th>/));
        await step("rename", (table) => assert.match(table, /<thead><tr><th scope="col">Id<\/th><th scope="col">Product<\/th>/));
        await step("swap", (table) => assert.match(table, /<th scope="col">I<\/th><th scope="col">P<\/th><th scope="col">N<\/th><\/tr>/), ["0", "1", "2", "5", "4", "3"]);
        await step("drop", (table) => assert.match(table, / columns: Id:1,Product:1,-:2,I:1,N:1$/));
        await step("add", (table) => assert.match(table, /<tr><td>3<\/td><td>Pen<\/td><td><b>Pen:quiet:compact<\/b>2<\/td><td>3<\/td><td>Pen<\/td><\/tr>/));
        await step("toggle", (table) => assert.match(table, /^<table><caption>4 columns<\/caption>/));
        // The plain note moves to the next outlet when the first goes.
        await step("unlead", (table) => assert.match(table, /<tfoot><tr><td><i>kept<\/i><\/td><td><\/td><td><\/td><td><\/td><\/tr><\/tfoot>/));
        await step("warn", () => {});
        const accepting = (list: readonly string[]) => [...new Set(list.filter((text) => /left out|has props/.test(text)).map((text) => text.replace(/^.*?(?=`)/, "")))].sort();
        assert.deepEqual(accepting(warnings["compiled fresh"]!), ["`x-datatable`'s default slot accepts `x-column`; this `<b>` is left out.", "`x-datatable`'s default slot accepts `x-column`; this text is left out."]);
        for (const [name] of others) assert.deepEqual(accepting(warnings[name]!), accepting(warnings["compiled fresh"]!), `${name} warnings`);
        assert.deepEqual(errors, []);
        for (const [name, list] of Object.entries(warnings)) {
          assert.deepEqual(list.filter((text) => !text.startsWith("Feature flags ") && /hydration|mismatch|outside of the render function/i.test(text)), [], name);
        }
      } finally {
        await browser.close();
      }
    });

    for (const mode of ["fresh", "hydrated"] as const) {
      it(`${engine} ${mode}: a read before the outlet holds the direct columns in server output, then every column and its latest slot content`, async () => {
        const browser = await launchParityBrowser(browserType);
        try {
          const page = await browser.newPage();
          const problems: string[] = [];
          page.on("pageerror", (error) => problems.push(error.message));
          page.on("console", (message) => {
            if (message.type() === "error" || message.type() === "warning" && !message.text().startsWith("Feature flags ") && /hydration|mismatch/i.test(message.text())) problems.push(message.text());
          });
          await page.setContent(`<div id="mount">${mode === "fresh" ? "" : server.first}</div>`);
          await page.evaluate(`window.consumer = "first"`);
          await page.addScriptTag({ path: mode === "fresh" ? fresh : hydrate });
          const notes = async (expected: string[]) => {
            const read = `JSON.stringify(Array.from(document.querySelectorAll("section p"), (note) => note.textContent))`;
            await page.waitForFunction(`${read} === ${JSON.stringify(JSON.stringify(expected))}`, undefined, { timeout: 3_000 }).catch(() => {});
            assert.deepEqual(JSON.parse(await page.evaluate(read) as string), expected);
          };
          await notes(["D", "N0"]);
          await page.locator("button.count").click();
          await notes(["D", "N1"]);
          assert.deepEqual(problems, []);
        } finally {
          await browser.close();
        }
      });

      it(`${engine} ${mode}: a wrapper's own state adds, removes, reorders and renames its columns among direct ones`, async () => {
        const browser = await launchParityBrowser(browserType);
        try {
          const page = await browser.newPage();
          const problems: string[] = [];
          page.on("pageerror", (error) => problems.push(error.message));
          page.on("console", (message) => {
            if (message.type() === "error" || message.type() === "warning" && !message.text().startsWith("Feature flags ") && /hydration|mismatch|left out/i.test(message.text())) problems.push(message.text());
          });
          await page.setContent(`<div id="mount">${mode === "fresh" ? "" : server.ownState}</div>`);
          if (mode === "hydrated") await page.evaluate(`window.serverCells = Array.from(document.querySelectorAll("td"))`);
          await page.evaluate(`window.consumer = "ownState"`);
          await page.addScriptTag({ path: mode === "fresh" ? fresh : hydrate });
          const shape = () => page.evaluate(`(() => { const table = document.querySelector("table"); const texts = (selector) => Array.from(table.querySelectorAll(selector), (cell) => cell.textContent.trim());
            return { caption: table.caption.textContent, head: texts("thead th"), row: texts("tbody tr:first-child td"), foot: texts("tfoot td"), columns: table.getAttribute("data-columns") }; })()`);
          const until = async (head: string[], row: string[], label: string) => {
            const expected = { caption: head.length + " columns", head, row, foot: head.map((header) => header === "Last" ? "kept" : "-"), columns: head.map((header) => header + ":1").join(",") };
            const deadline = Date.now() + 3_000;
            let actual = await shape();
            while (JSON.stringify(actual) !== JSON.stringify(expected) && Date.now() < deadline) { await page.waitForTimeout(16); actual = await shape(); }
            assert.deepEqual(actual, expected, label);
          };
          const last = "A:quiet:compact";
          await until(["Direct", "B", "C", "Last"], ["A", "2", "1", last], "first");
          if (mode === "hydrated") assert.equal(await page.evaluate(`window.serverCells.every((cell) => cell.isConnected)`), true);
          await page.evaluate(`window.pair({ label: "Z" })`);
          await until(["Direct", "Z", "C", "Last"], ["A", "2", "1", last], "a prop in a wrapper reaches the entry");
          await page.evaluate(`window.pair({ field: "name" })`);
          await until(["Direct", "Z", "C", "Last"], ["A", "A", "1", last], "a prop in a wrapper reaches the cells");
          await page.evaluate(`Array.from(document.querySelectorAll("tbody td"), (cell) => { cell.dataset.was = cell.textContent.trim(); })`);
          await page.evaluate(`window.pair({ flip: true })`);
          await until(["Direct", "C", "Z", "Last"], ["A", "1", "A", last], "a keyed move in a wrapper");
          assert.deepEqual(await page.evaluate(`Array.from(document.querySelectorAll("tbody td"), (cell) => cell.dataset.was)`), ["A", "1", "A", last], "cells move with their column");
          await page.evaluate(`window.pair({ more: true })`);
          await until(["Direct", "C", "M", "Z", "Last"], ["A", "1", "A", "A", last], "a column added in a wrapper");
          await page.evaluate(`window.pair({ off: true })`);
          await until(["Direct", "Last"], ["A", last], "a wrapper's columns removed");
          await page.locator("button.last").click();
          await until(["Direct"], ["A"], "the consumer removes a wrapper");
          await page.locator("button.last").click();
          await page.evaluate(`window.pair({ off: false, more: false, flip: false })`);
          await until(["Direct", "Z", "C", "Last"], ["A", "A", "1", last], "all back in document order");
          assert.deepEqual(problems, []);
        } finally {
          await browser.close();
        }
      });
    }
  }
});
