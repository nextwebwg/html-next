import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "vitest";

import { compileScript, compileTemplate, parse as parseVue } from "@vue/compiler-sfc";
import { transform } from "esbuild";

import { generateComponent, generateVueComponent } from "../src/generate.js";
import { parseComponent } from "../src/source-parser.js";

const fixtureUrl = new URL("./fixtures/x-button.html", import.meta.url);

// The component name is derived from `tag` and the native root inferred from `template`;
// `props` supplies the `<prop>` declarations for the bindings in `template`.
function componentSource(tag: string, props: string, template: string): string {
  const group = props === "" ? "" : `<props>${props}</props>`;
  return `<template component="${tag}" status="experimental" summary="A target compiler fixture.">${group}${template}</template>`;
}

function generated(source: string): Map<string, string> {
  return new Map(
    generateComponent(parseComponent(source)).map((artifact) => [artifact.path, artifact.content]),
  );
}

async function targets(): Promise<Map<string, string>> {
  const source = await readFile(fixtureUrl, "utf8");
  return new Map(
    generateComponent(parseComponent(source, "x-button.html")).map((artifact) => [
      artifact.path,
      artifact.content,
    ]),
  );
}

/** Compiles a generated SFC with Vue's own compiler, failing on any parse or template error. */
function compileVue(source: string, filename: string): string {
  const parsed = parseVue(source, { filename });
  assert.deepEqual(parsed.errors, [], `${filename}: parse`);
  const script = compileScript(parsed.descriptor, { id: filename, inlineTemplate: true });
  const template = compileTemplate({
    id: filename,
    filename,
    source: parsed.descriptor.template!.content,
    compilerOptions: { bindingMetadata: script.bindings ?? {} },
  });
  assert.deepEqual(template.errors, [], `${filename}: template`);
  return script.content;
}

/** Module specifiers a converted component imports. */
function importsOf(source: string): string[] {
  return [...source.matchAll(/^import[^"\n]*"([^"]+)"/gm)].map((match) => match[1]!);
}

const featureSource = `<template component="x-feature" status="experimental" summary="Every convertible construct." controller="./x-feature.js">
  <defs>
    <prop name="label" type="string" default="Items">Heading.</prop>
    <prop name="items" type="list(object({ id: string, name: string, done: boolean }))">Rows.</prop>
    <prop name="size" type="sm | md" default="md">Size.</prop>
    <state name="open" :value="false"></state>
    <state name="query" :value="''"></state>
    <computed name="count" from="items.length"></computed>
    <event name="toggle" type="object({ open: boolean })"></event>
    <handler name="flip"><set name="open" :value="not open"></set><dispatch event="toggle" :detail="{ open: open }"></dispatch></handler>
    <method name="focusSearch" export="focusSearch" returns="promise(undefined)"></method>
  </defs>
  <section class="panel" class:compact="size = 'sm'" style:--gap="size">
    <h2 $value="label"></h2>
    <input $ref="search" bind:value="query">
    <button type="button" on:click="flip"><template $value="open"></template></button>
    <ul $if="open">
      <li $each="item, index of items" $key="item.id" $where="item.done" $sort="name"><span $value="item.name"></span></li>
    </ul>
    <template $match>
      <small $when="size = 'sm'">small</small>
      <span $else>regular</span>
    </template>
    <x-badge :tone="size"><slot name="badge">none</slot></x-badge>
    <slot></slot>
  </section>
  <style>
    :host { display: block; }
    :host-state([open]) .panel { outline: 1px solid; }
    :host-state([size="sm"]) h2 { font-size: small; }
    :slotted(p) { margin: 0; }
    x-badge { margin-inline: auto; }
  </style>
</template>`;

describe("official target compilers", () => {
  it("gives a native form-control root Vue's v-model", () => {
    const outputs = generated(componentSource(
      "x-field",
      '<prop name="value" type="string">Value.</prop>',
      '<input :value="value">',
    ));
    const vue = outputs.get("vue/XField.vue")!;
    compileVue(vue, "XField.vue");
    assert.match(vue, /modelValue\?: string \| null;/);
    assert.match(vue, /"update:modelValue": \[value: string\];/);
    assert.match(vue, /<input data-component="x-field" v-bind="\$attrs" v-model="model">/);
    assert.match(vue, /const model = computed\(\{\n  get: \(\) => props\.modelValue \?\? props\.value \?\? undefined,/);
    // A select takes v-model too, so Vue selects the model's option once the slotted options exist.
    const select = generated(componentSource("x-choice", '<prop name="value" type="string">Value.</prop>', '<select :value="value"><slot></slot></select>')).get("vue/XChoice.vue")!;
    assert.match(select, /<select data-component="x-choice" v-bind="\$attrs" v-model="model">/);
  });

  it("keeps logical operators readable in Vue attribute values", () => {
    const vue = generated(componentSource(
      "x-both",
      '<prop name="a" type="boolean" default="false">A.</prop><prop name="b" type="boolean" default="false">B.</prop>',
      '<button :hidden="a and b" :title="a" :data-b="b"></button>',
    )).get("vue/XBoth.vue")!;
    compileVue(vue, "XBoth.vue");
    assert.match(vue, /:hidden="a && b"/);
    assert.match(vue, /:title="a \? '' : undefined"/);
  });

  it("serializes booleans on enumerated attributes as true and false", () => {
    const outputs = generated(componentSource(
      "x-aria",
      '<prop name="open" type="boolean" default="false">Open.</prop><prop name="gone" type="boolean" default="false">Gone.</prop>',
      '<button :aria-expanded="open" :hidden="gone"></button>',
    ));
    const vue = outputs.get("vue/XAria.vue")!;
    compileVue(vue, "XAria.vue");
    // Vue writes a boolean on an ARIA attribute as "true" or "false", and removes a false boolean attribute.
    assert.match(vue, /:aria-expanded="open"/);
    assert.match(vue, /:hidden="gone"/);
    const vanilla = outputs.get("vanilla/XAria.js")!;
    assert.match(vanilla, /setAttribute\("aria-expanded", String\(value\d+\)\)/);
    assert.match(vanilla, /setAttribute\("hidden", ""\)/);
  });

  it("parses generated Vanilla source", async () => {
    const generated = await targets();
    await transform(generated.get("vanilla/XButton.js")!, { loader: "js" });
  });

  it("converts to a Vue SFC that imports only Vue and the component's own modules", () => {
    const vue = generated(featureSource).get("vue/XFeature.vue")!;
    compileVue(vue, "XFeature.vue");
    assert.deepEqual(importsOf(vue).sort(), ["./XBadge.vue", "./x-feature.js", "vue"]);
    assert.doesNotMatch(vue, /@nextwebwg|html-next|attachComponent|manageGeneratedProps/);
  });

  it("maps each construct to Vue's own facility, as a Vue author writes it", () => {
    const vue = generated(featureSource).get("vue/XFeature.vue")!;
    assert.doesNotMatch(vue, /\bhn\b/);
    assert.match(vue, /const open = ref\(false\);/);
    assert.match(vue, /const query = ref\(""\);/);
    assert.match(vue, /const count = computed\(\(\) => props\.items\?\.length\);/);
    assert.match(vue, /const searchElement = useTemplateRef<HTMLElement>\("search"\);/);
    assert.match(vue, /const hostState = computed\(\(\) => \[\n  open\.value && "open",\n  props\.size && `size size=\$\{props\.size\}`,\n\]\.filter\(Boolean\)\.join\(" "\)\);/);
    assert.match(vue, /function flip\(\): void \{\n  open\.value = !open\.value;/);
    assert.match(vue, /<ul v-if="open">/);
    assert.match(vue, /v-for="\(item, index\) in sortBy\(\(items \?\? \[\]\)\.filter\(\(item\) => item\.done\), \['name'\]\)"/);
    assert.match(vue, /:key="item\.id"/);
    assert.match(vue, /<span>\{\{ item\.name \}\}<\/span>/);
    assert.match(vue, /<input v-model="query" ref="search">/);
    assert.match(vue, /@click="flip"/);
    assert.match(vue, /:class="\{ 'compact': size === 'sm' \}"/);
    assert.match(vue, /:style="\{ '--gap': size \}"/);
    assert.match(vue, /<XBadge :tone="size">\n\s+<slot name="badge">none<\/slot>\n\s+<\/XBadge>/);
    assert.match(vue, /<small v-if="size === 'sm'">small<\/small>\n\s+<span v-else>regular<\/span>/);
    assert.match(vue, /defineExpose\(\{\n  focusSearch: async/);
    assert.match(vue, /onMounted\(\(\) => \{\n  ready = Promise\.resolve\(controllerModule\.default\(host as never\)\)/);
  });

  it("reads a typed state list's items as plainly as a typed prop's", () => {
    const vue = generated(`<template component="x-tabs" status="experimental" summary="Typed state.">` +
      `<defs><state name="tabs" type="list(object({ id: string, label: string, active: boolean }))" :value="[]"></state></defs>` +
      `<div><button $each="tab of tabs" $key="tab.id" :id="tab.id" :aria-selected="tab.active" class:active="tab.active"><template $value="tab.label"></template></button></div></template>`,
    ).get("vue/XTabs.vue")!;
    compileVue(vue, "XTabs.vue");
    assert.match(vue, /const tabs = ref<\{ id: string; label: string; active: boolean \}\[\]>\(\[\]\);/);
    assert.match(vue, /v-for="tab in tabs"/);
    assert.match(vue, /:id="tab\.id" :aria-selected="tab\.active" :class="\{ 'active': tab\.active \}">\{\{ tab\.label \}\}/);
    assert.doesNotMatch(vue, /function (truthy|text|attribute)\(/);
  });

  it("types optional fields, open objects, and nullable records in state", () => {
    const vue = generated(`<template component="x-hover" status="experimental" summary="Typed records.">` +
      `<defs><state name="hovered" type="object({ row: integer, label?: string, ... }) | null" :value="null"></state>` +
      `<state name="issues" type="list(object({ message: string }))" :value="[]"></state></defs>` +
      `<div><span $if="hovered" :title="hovered.label"></span><p $if="not issues.length">Valid</p></div></template>`,
    ).get("vue/XHover.vue")!;
    compileVue(vue, "XHover.vue");
    assert.match(vue, /const hovered = ref<\{ row: number; label\?: string; \[name: string\]: any \} \| null>\(null\);/);
    assert.match(vue, /<span v-if="hovered" :title="hovered\?\.label"/);
    assert.match(vue, /<p v-if="!issues\.length">Valid<\/p>/);
    assert.doesNotMatch(vue, /function truthy\(/);
  });

  it("rejects a state type that does not parse", () => {
    assert.throws(() => generated(`<template component="x-bad" status="experimental" summary="Bad state type.">` +
      `<defs><state name="rows" type="list(" :value="[]"></state></defs><div></div></template>`), /HC013/);
  });

  it("renders $value text, including a wrapper-less <template $value> slot fallback", () => {
    for (const controller of ["", ' controller="./x-row.js"']) {
      const vue = generated(
        `<template component="x-row" status="experimental" summary="A target compiler fixture."${controller}>` +
        `<defs><prop name="label" type="string" default="">Row label.</prop></defs>` +
        `<div><h2 $value="label"></h2><span><slot name="label"><template $value="label"></template></slot></span></div></template>`,
      ).get("vue/XRow.vue")!;
      compileVue(vue, "XRow.vue");
      assert.match(vue, /<h2>\{\{ label \}\}<\/h2>/, `${controller}: element text`);
      assert.match(vue, /<slot name="label">\{\{ label \}\}<\/slot>/, `${controller}: wrapper-less fallback`);
    }
  });

  it("keeps a slot inside a select, as the HTML Standard's select parsing does", () => {
    const vue = generated(
      `<template component="x-choice" status="experimental" summary="A target compiler fixture.">` +
      `<defs><prop name="disabled" type="boolean" default="false">Disabled.</prop></defs>` +
      `<select :disabled="disabled"><option value="">None</option><slot></slot></select></template>`,
    ).get("vue/XChoice.vue")!;
    compileVue(vue, "XChoice.vue");
    assert.match(vue, /<select[^>]*>\n\s+<option value="">None<\/option>\n\s+<slot \/>\n\s+<\/select>/);
  });

  it("types optional nullable props once", () => {
    const vue = generated(componentSource(
      "demo-anchor",
      `<prop name="anchor" type="start | end | null">Anchor edge.</prop>`,
      `<div :data-edge="anchor"></div>`,
    )).get("vue/DemoAnchor.vue")!;
    assert.match(vue, /anchor\?: "start" \| "end" \| null;/);
    assert.doesNotMatch(vue, /null \| null/);
  });

  it("rejects constructs Vue conversion does not map yet instead of approximating them", () => {
    const source = `<template component="demo-html" status="experimental" summary="Html.">
      <defs><state name="markup" :value="'<b>x</b>'"></state></defs><div $html="markup"></div></template>`;
    assert.throws(() => generateVueComponent(parseComponent(source)), /HT032/);
    // HTML Next's own outputs still build; only the Vue artifact is left out.
    const artifacts = generated(source);
    assert.equal(artifacts.has("vue/DemoHtml.vue"), false);
    assert.equal(artifacts.has("vanilla/DemoHtml.js"), true);
  });

  it("emits a standalone Vanilla module when the component has no runtime behavior", () => {
    const module = generated(componentSource(
      "demo-card",
      "",
      `<article><h2>Card</h2><slot></slot></article>`,
    )).get("vanilla/DemoCard.js")!;

    assert.doesNotMatch(module, /@nextwebwg\/html-next\/runtime/);
    assert.doesNotMatch(module, /manageComponentLifecycle|const definition/);
    assert.match(module, /document\.createElement\("article"\)/);
  });

  it("compiles simple numeric state directly to native browser primitives", async () => {
    const module = generated(`<template component="demo-counter" status="experimental" summary="Counter.">
      <defs>
        <state name="count" :value="0"></state>
        <handler name="increment">
          <set name="count" :value="count + 1"></set>
          <set name="count" :value="count + 1"></set>
        </handler>
      </defs>
      <button type="button" on:click="increment"><output $value="count"></output></button>
    </template>`).get("vanilla/DemoCounter.js")!;

    assert.doesNotMatch(module, /@nextwebwg\/html-next\/runtime/);
    assert.match(module, /queueMicrotask\(update\)/);
    assert.match(module, /addEventListener\("click", handler0\)/);
    assert.match(module, /const next0 = state0 \+ 1/);
    assert.match(module, /const next1 = state0 \+ 1/);
    await transform(module, { loader: "js" });
  });

  it("compiles scalar prop reflection without the live interpreter", async () => {
    const module = generated(componentSource(
      "demo-label",
      `<prop name="label" type="string" default="Ready">Label.</prop>`,
      `<output :data-label="label"><span $value="label"></span></output>`,
    )).get("vanilla/DemoLabel.js")!;

    assert.match(module, /html-next\/generated-runtime/);
    assert.doesNotMatch(module, /html-next\/runtime/);
    assert.match(module, /manageGeneratedProps/);
    await transform(module, { loader: "js" });
  });

  it("creates vanilla SVG subtrees in the SVG namespace", async () => {
    const module = generated(componentSource(
      "demo-icon",
      `<prop name="label" type="string" default="Close">Label.</prop>`,
      `<button :aria-label="label"><svg viewBox="0 0 24 24"><path d="M6 6l12 12"></path>` +
        `<foreignObject><span>html</span></foreignObject></svg></button>`,
    )).get("vanilla/DemoIcon.js")!;

    assert.match(module, /createElementNS\("http:\/\/www\.w3\.org\/2000\/svg", "svg"\)/);
    assert.match(module, /createElementNS\("http:\/\/www\.w3\.org\/2000\/svg", "path"\)/);
    assert.match(module, /createElementNS\("http:\/\/www\.w3\.org\/2000\/svg", "foreignObject"\)/);
    assert.match(module, /createElement\("span"\)/);
    assert.match(module, /createElement\("button"\)/);
    await transform(module, { loader: "js" });
  });

  it("keeps unsafe attribute sinks on the complete runtime path", () => {
    const module = generated(componentSource(
      "demo-link",
      `<prop name="target" type="string" default="https://example.test">Target.</prop>`,
      `<a :href="target"><slot></slot></a>`,
    )).get("vanilla/DemoLink.js")!;

    assert.match(module, /html-next\/runtime/);
    assert.doesNotMatch(module, /html-next\/generated-runtime/);
  });

  it("keeps the complete runtime for reactive shapes outside the direct subset", () => {
    const module = generated(`<template component="demo-derived" status="experimental" summary="Derived output.">
      <defs><state name="count" :value="0"></state></defs>
      <output $value="count + 1"></output>
    </template>`).get("vanilla/DemoDerived.js")!;

    assert.match(module, /@nextwebwg\/html-next\/runtime/);
    assert.match(module, /manageComponentLifecycle/);
  });

  it("scopes styles to the region with root-only markers, :host, :host-state(), and :slotted()", () => {
    const artifacts = generated(featureSource);
    const css = artifacts.get("styles/x-feature.css")!;
    assert.match(css, /@scope \(\[data-component~="x-feature"\]\) to \(\[data-component\], \[data-slotted\]\)/);
    assert.match(css, /:scope \{ display: block; \}/);
    assert.match(css, /:scope\[data-x-feature-state~="open"\] \.panel/);
    assert.match(css, /:scope\[data-x-feature-state~="size=sm"\] h2/);
    assert.match(css, /@scope \(\[data-component~="x-feature"\]\) to \(\[data-component\]\) \{\n:where\(\[data-slotted\], \[data-slotted\] \*\):is\(p\)/);
    assert.match(css, /:is\(x-badge, :where\(\[data-component~="x-badge"\]\)\)/);
    assert.doesNotMatch(css, /data-component-root/);

    const vue = artifacts.get("vue/XFeature.vue")!;
    const style = vue.slice(vue.indexOf("<style scoped>"));
    assert.match(style, /\[data-component~="x-feature"\] \{\n  display: block;\n\}/);
    assert.match(style, /\[data-component~="x-feature"\]\[data-x-feature-state~="open"\] \.panel/);
    assert.match(style, /:slotted\(p\)/);
    assert.match(vue, /data-component="x-feature"/);
    assert.match(vue, /:data-x-feature-state="hostState \|\| undefined"/);

    const vanilla = artifacts.get("vanilla/XFeature.js")!;
    assert.equal([...vanilla.matchAll(/setAttribute\("data-component"/g)].length, 1, "only the vanilla root is marked");
  });

  it("rejects :scope and undeclared :host-state() names", () => {
    assert.throws(() => generated(componentSource("demo-a", "", `<div></div><style>:scope { color: red; }</style>`)), /HY003/);
    assert.throws(() => generated(componentSource("demo-b", "", `<div></div><style>:host-state([missing]) { color: red; }</style>`)), /HY001/);
  });
});
