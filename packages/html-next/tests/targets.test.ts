import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";

import { compileScript, compileTemplate, parse as parseVue } from "@vue/compiler-sfc";
import { build, transform } from "esbuild";

import { generateComponent, generateVueComponent, vueHostArtifact, vueHtmlArtifact, vuePropsArtifact } from "../src/generate.js";
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
  return [...source.matchAll(/^(?:import|\} from)[^'\n]*'([^']+)'/gm)].map((match) => match[1]!);
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
  it("uses a root $ref as the controller's root handle without duplicate Vue refs", () => {
    const vue = generated(`<template component="x-root-ref" controller="./root.js" status="early" summary="Root reference.">
      <button $ref="control" type="button">Go</button>
    </template>`).get("vue/XRootRef.vue")!;
    compileVue(vue, "XRootRef.vue");
    assert.match(vue, /const root = controlElement\b/);
    assert.match(vue, /<button[^>]*ref="control"/);
    assert.doesNotMatch(vue, /ref="root"/);
  });

  it("keeps Vue's modelValue API while binding a native root through its DOM events", () => {
    const outputs = generated(componentSource(
      "x-field",
      '<prop name="value" type="string">Value.</prop>',
      '<input :value="value">',
    ));
    const vue = outputs.get("vue/XField.vue")!;
    compileVue(vue, "XField.vue");
    assert.match(vue, /modelValue: \{ type: null as unknown as PropType<string \| null> \}/);
    assert.match(vue, /'update:modelValue': \[value: string\]\n/);
    assert.match(vue, /<input\s+data-component="x-field"/);
    assert.match(vue, /v-bind-control="\{ tag: 'input', name: 'value', value: model, defaultValue: '' \}"/);
    assert.match(vue, /@input="model = readBoundControl\(/);
    assert.match(vue, /const model = computed\(\{\n  get: \(\) => checkedProps\.value\.modelValue \?\? checkedProps\.value\.value \?\? undefined,/);
    // The select uses the same native-control bridge; Vue's v-model would reassert stale state.
    const select = generated(componentSource("x-choice", '<prop name="value" type="string">Value.</prop>', '<select :value="value"><slot></slot></select>')).get("vue/XChoice.vue")!;
    assert.match(select, /<select\s+data-component="x-choice"/);
    assert.match(select, /v-bind-control="\{ tag: 'select', name: 'value', value: model, defaultValue: '' \}"/);
    assert.match(select, /@change="model = readBoundControl\(/);
    assert.match(select, /<SelectedOptions\s+:value="model"\s+:multiple="false"\s+:native-property="false"/);
    assert.doesNotMatch(select, /v-model=/);
  });

  it("maps native property and attribute bindings to different Vue primitives", () => {
    const vue = generated(componentSource(
      "x-native-control-primitives",
      '<prop name="value" type="string">Value.</prop><prop name="selected" type="boolean">Selected.</prop>',
      '<div><input class="property" .value="value" value="authored"><input class="attribute" :value="value"><input type="checkbox" :checked="selected"></div>',
    )).get("vue/XNativeControlPrimitives.vue")!;
    compileVue(vue, "XNativeControlPrimitives.vue");
    assert.match(vue, /<input\s+class="property"\s+v-bind-control="\{[\s\S]*?value: checkedProps\.value,[\s\S]*?nativeProperty: true,[\s\S]*?defaultValue: 'authored',[\s\S]*?\}"/);
    assert.doesNotMatch(vue, /<input\s+class="property"[^>]*:value=/);
    assert.match(vue, /<input class="attribute" :value\.attr=/);
    assert.match(vue, /<input type="checkbox" :checked\.attr=/);
    assert.doesNotMatch(vue, /v-preserve-hydrated-control=/);
  });

  it("passes repeated scoped-slot values through Vue's native slot outlet", () => {
    const vue = generated(`<template component="x-row-list"><defs>` +
      '<prop name="rows" type="list(object({ id: string, name: string }))">Rows.</prop></defs>' +
      '<ul><slot $each="row of rows" $key="row.id" name="row" :item="row" :index="loop.index"><li $value="row.name"></li></slot></ul></template>')
      .get("vue/XRowList.vue")!;
    compileVue(vue, "XRowList.vue");
    assert.match(vue, /v-for="[^"]*checkedProps\.rows/);
    assert.match(vue, /<slot :name="scopedSlotName\('row'\)" :item="row" :index="loop\.index">/);
    assert.match(vue, /<li>\s*\{\{ row\.name \}\}\s*<\/li>/);
  });

  it("converts a consumer's scoped-slot template with its lexical state", () => {
    const vue = generated(`<template component="x-consumer"><defs><state name="heading" value="People"></state></defs>` +
      `<section><x-row-list><template slot="row"><b $value="item.name"></b><i $value="heading"></i></template></x-row-list></section></template>`)
      .get("vue/XConsumer.vue")!;
    compileVue(vue, "XConsumer.vue");
    assert.match(vue, /<template #row="\{ item \}">/);
    assert.match(vue, /\{\{ text\(item\?\.name\) \}\}/);
    assert.match(vue, /\{\{ heading \}\}/);
  });

  it("keeps logical operators readable in Vue attribute values", () => {
    const vue = generated(componentSource(
      "x-both",
      '<prop name="a" type="boolean" default="false">A.</prop><prop name="b" type="boolean" default="false">B.</prop>',
      '<button :hidden="a and b" :title="a" :data-b="b"></button>',
    )).get("vue/XBoth.vue")!;
    compileVue(vue, "XBoth.vue");
    assert.match(vue, /:hidden="checkedProps\.a && checkedProps\.b"/);
    assert.match(vue, /:title="checkedProps\.a \? '' : undefined"/);
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
    assert.match(vue, /:aria-expanded="checkedProps\.open"/);
    assert.match(vue, /:hidden="checkedProps\.gone"/);
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
    assert.deepEqual(importsOf(vue).sort(), ["./XBadge.vue", "./control", "./host", "./props", "vue", "vue"]);
    assert.match(vue, /\(\) => import\('\.\/x-feature\.js'\)/);
    assert.doesNotMatch(vue, /@nextwebwg|html-next|attachComponent|manageGeneratedProps/);
  });

  it("maps each construct to Vue's own facility, as a Vue author writes it", () => {
    const vue = generated(featureSource).get("vue/XFeature.vue")!;
    assert.doesNotMatch(vue, /\bhn\b/);
    assert.match(vue, /const open = ref\(false\)\n/);
    assert.match(vue, /const query = ref\(''\)\n/);
    assert.match(vue, /const count = cycleCheckedComputed\(\(\) => checkedProps\.value\.items\?\.length\)\n/);
    assert.match(vue, /const searchElement = useTemplateRef<HTMLElement>\('search'\)\n/);
    assert.match(vue, /const hostState = computed\(\(\) =>\n  \[\n    open\.value && 'open',\n    checkedProps\.value\.size && `size size=\$\{checkedProps\.value\.size\}`,\n  \]\.filter\(Boolean\)\.join\(' '\)\n\)/);
    assert.match(vue, /function flip\(\): void \{\n  open\.value = !open\.value\n/);
    assert.match(vue, /<ul v-if="open">/);
    assert.match(vue, /v-for="\(item, index\) in uniqueKeys\(/);
    assert.match(vue, /sortBy\(\(checkedProps\.items \?\? \[\]\)\.filter\(\(item\) => item\.done\), \['name'\]\)/);
    assert.match(vue, /\(item, index, loop\) => item\.id/);
    assert.match(vue, /:key="item\.id"/);
    assert.match(vue, /<span>\{\{ item\.name \}\}<\/span>/);
    assert.match(vue, /v-bind-control="\{ tag: 'input', name: 'value', value: query, defaultValue: '' \}"/);
    assert.match(vue, /@input="query = readBoundControl\(/);
    assert.match(vue, /@click="flip"/);
    assert.match(vue, /:class="\{ compact: checkedProps\.size === 'sm' \}"/);
    assert.match(vue, /:style="\{ '--gap': checkedProps\.size \}"/);
    assert.match(vue, /<XBadge :tone="checkedProps\.size"><slot name="badge">none<\/slot><\/XBadge>/);
    assert.match(vue, /<small v-if="checkedProps\.size === 'sm'">small<\/small>\n\s+<span v-else>regular<\/span>/);
    assert.match(vue, /defineExpose\(\{\n  focusSearch: async/);
    assert.match(vue, /const \{ host, ready \} = useComponentHost\(\(\) => import\('\.\/x-feature\.js'\), \{\n  root,\n  dispatch,\n  controllerSource:/);
    assert.match(vue, /props: checkedProps,/);
  });

  it("reads a typed state list's items plainly while checking its keys", () => {
    const vue = generated(`<template component="x-tabs" status="experimental" summary="Typed state.">` +
      `<defs><state name="tabs" type="list(object({ id: string, label: string, active: boolean }))" :value="[]"></state></defs>` +
      `<div><button $each="tab of tabs" $key="tab.id" :id="tab.id" :aria-selected="tab.active" class:active="tab.active"><template $value="tab.label"></template></button></div></template>`,
    ).get("vue/XTabs.vue")!;
    compileVue(vue, "XTabs.vue");
    assert.match(vue, /const tabs = ref<\{ id: string; label: string; active: boolean \}\[\]>\(\[\]\)\n/);
    assert.match(vue, /v-for="tab in uniqueKeys\(tabs, \(tab, index, loop\) => tab\.id\)"/);
    assert.match(vue, /:id="tab\.id"\n\s+:aria-selected="tab\.active"\n\s+:class="\{ active: tab\.active \}"\n\s+>\n?\s*\{\{ tab\.label \}\}/);
    assert.doesNotMatch(vue, /function (truthy|attribute)\(/);
  });

  it("types optional fields, open objects, and nullable records in state", () => {
    const vue = generated(`<template component="x-hover" status="experimental" summary="Typed records.">` +
      `<defs><state name="hovered" type="object({ row: integer, label?: string, ... }) | null" :value="null"></state>` +
      `<state name="issues" type="list(object({ message: string }))" :value="[]"></state></defs>` +
      `<div><span $if="hovered" :title="hovered.label"></span><p $if="not issues.length">Valid</p></div></template>`,
    ).get("vue/XHover.vue")!;
    compileVue(vue, "XHover.vue");
    assert.match(vue, /const hovered = ref<\{ row: number; label\?: string; \[name: string\]: any \} \| null>\(null\)\n/);
    assert.match(vue, /if \(!\(hovered\.value\?\.\['label'\] == null \|\| typeof hovered\.value\?\.\['label'\] === 'string'\)\)/);
    assert.match(vue, /<span v-if="hovered" :title="guarded"/);
    assert.match(vue, /<p v-if="!issues\.length">Valid<\/p>/);
    assert.doesNotMatch(vue, /function truthy\(/);
  });

  it("updates a prop from an event that reports it, for v-model:<prop>", () => {
    const vue = generated(`<template component="x-picker" status="experimental" summary="Reported props.">` +
      `<defs><prop name="query" type="string" default="">Query.</prop><prop name="open" type="boolean" default="false">Open.</prop>` +
      `<event name="query-change" type="object({ query: string })"></event><event name="close" type="object({ open: boolean })"></event></defs>` +
      `<div></div></template>`,
    ).get("vue/XPicker.vue")!;
    compileVue(vue, "XPicker.vue");
    assert.match(vue, /'update:query': \[value: string\]/);
    assert.match(vue, /'update:open': \[value: boolean\]/);
    assert.match(vue, /modeled: \['open', 'query'\]/);
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
      assert.match(vue, /<h2>\{\{ checkedProps\.label \}\}<\/h2>/, `${controller}: element text`);
      assert.match(vue, /<slot name="label">\{\{ checkedProps\.label \}\}<\/slot>/, `${controller}: wrapper-less fallback`);
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
    assert.match(vue, /anchor: \{ type: null as unknown as PropType<'start' \| 'end' \| null> \}/);
    assert.doesNotMatch(vue, /null \| null/);
  });

  it("renders a polymorphic root as the native root its `$match` arm chooses", async () => {
    const outputs = generated(`<template component="x-action" status="experimental" summary="Button or link.">
  <defs>
    <prop name="as" type="button | a" default="button">Native root.</prop>
    <prop name="href" type="string">Link.</prop>
    <prop name="disabled" type="boolean" default="false">Off.</prop>
  </defs>
  <template $match>
    <a $when="as = 'a'" class="action" :href="{ true: null, false: href }[format('%s', disabled)]" $ref="control"><slot></slot></a>
    <button $else class="action" type="button" :disabled="disabled" $ref="control"><slot></slot></button>
  </template>
  <style>:host { display: inline-flex; }</style>
</template>`);
    const vue = outputs.get("vue/XAction.vue")!;
    assert.match(vue, /as: \{ type: null as unknown as PropType<'button' \| 'a'>, default: 'button' \}/);
    assert.match(vue, /<a\n\s+v-if="checkedProps\.as === 'a'"/);
    assert.match(vue, /<button\n\s+v-else\n/);
    const script = compileVue(vue, "XAction.vue");
    const bundle = await build({
      stdin: {
        contents: `${script}\nexport { createSSRApp, h } from "vue";\nexport { renderToString } from "@vue/server-renderer";`,
        loader: "ts",
        resolveDir: fileURLToPath(new URL("..", import.meta.url)),
      },
      bundle: true,
      format: "esm",
      platform: "node",
      write: false,
      logLevel: "silent",
      plugins: [{ name: "generated-vue-helpers", setup(bundler) {
        bundler.onResolve({ filter: /^\.\/host$/ }, () => ({ path: "host", namespace: "generated-vue-host" }));
        bundler.onLoad({ filter: /^host$/, namespace: "generated-vue-host" }, () => ({ contents: vueHostArtifact().content, loader: "ts", resolveDir: fileURLToPath(new URL("..", import.meta.url)) }));
        bundler.onResolve({ filter: /^\.\/props$/ }, () => ({ path: "props", namespace: "generated-vue-props" }));
        bundler.onLoad({ filter: /^props$/, namespace: "generated-vue-props" }, () => ({ contents: vuePropsArtifact().content, loader: "ts", resolveDir: fileURLToPath(new URL("..", import.meta.url)) }));
      } }],
    });
    const module = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0]!.text).toString("base64")}`);
    const render = (props: Record<string, unknown>): Promise<string> =>
      module.renderToString(module.createSSRApp({ render: () => module.h(module.default, props, { default: () => "Go" }) }))
        .then((html: string) => html.replace(/<!--[[\]]-->/g, "").replace(/ data-v-[\w-]+(?:="")?/g, ""));
    assert.equal(await render({}), '<button data-component="x-action" class="action" type="button">Go</button>');
    assert.equal(await render({ as: "a", href: "/next" }), '<a data-component="x-action" class="action" href="/next" data-as="a" data-href="/next">Go</a>');
    // A null binding leaves the attribute off, so a disabled link has no href.
    assert.equal(await render({ as: "a", href: "/next", disabled: true }), '<a data-component="x-action" class="action" data-as="a" data-disabled="true" data-href="/next">Go</a>');
    assert.match(await render({ constructor: "safe" }), / constructor="safe"/);

    const vanilla = outputs.get("vanilla/XAction.js")!;
    await transform(vanilla, { loader: "js", format: "esm" });
    assert.match(vanilla, /import \{ componentRootIndex, manageComponentLifecycle \}/);
    assert.match(vanilla, /const root = componentRootIndex\(definition, componentProps\);\n  let element;\n  if \(root === 0\) \{\n    element = document\.createElement\("a"\);/);
    assert.match(vanilla, /\} else \{\n    element = document\.createElement\("button"\);/);
    assert.match(outputs.get("vanilla/XAction.d.ts")!, /interface XActionElement extends HTMLElement/);
    assert.match(outputs.get("docs/x-action.md")!, /Native element: `<a>` or `<button>`/);
  });

  it("converts a real-element root match and rejects a non-element root guard", () => {
    // A real-element $match keeps that element as the root and switches only its chosen child.
    const section = generateVueComponent(parseComponent(componentSource(
      "x-section",
      '<prop name="as" type="a | b" default="a">Kind.</prop>',
      `<section $match :data-as="as"><p $when="as = 'a'">A</p><p $else>B</p></section>`,
    )));
    assert.match(section, /<section[\s\S]*<p v-if="checkedProps\.as === 'a'">A<\/p>/);
    assert.throws(() => generateVueComponent(parseComponent(componentSource(
      "x-guarded",
      '<prop name="show" type="boolean" default="true">Show.</prop>',
      `<section $if="show" :data-show="show">Visible</section>`,
    ))), /HT021/);
    // $html is supported through a generated, feature-specific sanitizer helper.
    const source = `<template component="demo-html" status="experimental" summary="Html.">
      <defs><state name="markup" :value="'<b>x</b>'"></state></defs><div $html="markup"></div></template>`;
    const artifacts = generated(source);
    assert.match(artifacts.get("vue/DemoHtml.vue")!, /from '\.\/html'/);
    assert.equal(artifacts.has("vanilla/DemoHtml.js"), true);
  });

  it("server-renders sanitized $html through Vue nodes with scoped styling markers", async () => {
    const helper = vueHtmlArtifact().content;
    const bundle = await build({
      stdin: {
        contents: `${helper}\nexport { createSSRApp, h } from "vue";\nexport { renderToString } from "@vue/server-renderer";`,
        loader: "ts",
        resolveDir: fileURLToPath(new URL("..", import.meta.url)),
      },
      bundle: true,
      format: "esm",
      platform: "node",
      write: false,
      logLevel: "silent",
    });
    const module = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0]!.text).toString("base64")}`);
    const Parent = { __scopeId: "data-v-safe", render: () => module.h("article", [
      module.h(module.SanitizedHtml, { value: "<b title='safe'>One</b><img src=x onerror=alert(1)>" }),
    ]) };
    const output = await module.renderToString(module.createSSRApp(Parent));
    assert.match(output, /<b[^>]*title="safe"[^>]*>One<\/b>/);
    assert.match(output, /<b[^>]*data-v-safe/);
    assert.doesNotMatch(output, /<img|onerror|<script/);
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

  it("rejects :scope and undeclared or structured :host-state() names", () => {
    assert.throws(() => generated(componentSource("demo-a", "", `<div></div><style>:scope { color: red; }</style>`)), /HY003/);
    assert.throws(() => generated(componentSource("demo-b", "", `<div></div><style>:host-state([missing]) { color: red; }</style>`)), /HY001/);
    assert.throws(() => generated(componentSource("demo-c", "", `<defs><state name="items" type="list(string)" :value="[]"></state></defs><div></div><style>:host-state([items]) { color: red; }</style>`)), /HY002/);
  });
});
