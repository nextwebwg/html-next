import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, it } from "vitest";

import { compileScript, compileTemplate, parse as parseVue } from "@vue/compiler-sfc";
import { build, transform } from "esbuild";

import { generateComponent, generateVueComponent, vueHostArtifact, vueHtmlArtifact, vuePropsArtifact } from "../src/generate.js";
import { parseComponent } from "../src/source-parser.js";

const fixtureUrl = new URL("./fixtures/x-button.html", import.meta.url);
const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const run = promisify(execFile);

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

  it("types an optional Vue prop so an explicit undefined means unset", async () => {
    const vue = generated(componentSource(
      "x-optional",
      '<prop name="label" type="string">Label.</prop><prop name="size" type="sm | md" default="md">Size.</prop>' +
        '<prop name="count" type="number" required>Count.</prop>',
      '<p :data-label="label" :data-size="size" :data-count="count"></p>',
    )).get("vue/XOptional.vue")!;
    // Vue reads an explicit undefined as an absent prop, so the type admits it; a required prop does not.
    assert.match(vue, /label: \{ type: null as unknown as PropType<string \| undefined> \}/);
    assert.match(vue, /size: \{ type: null as unknown as PropType<'sm' \| 'md' \| undefined>, default: 'md' \}/);
    assert.match(vue, /count: \{ type: null as unknown as PropType<number> \}/);

    // A consumer under exactOptionalPropertyTypes can pass undefined for an optional prop, still
    // cannot pass a value outside its type, and cannot pass undefined for a required one.
    const directory = await mkdtemp(join(packageRoot, ".vue-types-"));
    try {
      await writeFile(join(directory, "XOptional.ts"), compileVue(vue, "XOptional.vue"));
      await writeFile(join(directory, "props.ts"), vuePropsArtifact().content);
      await writeFile(join(directory, "consumer.ts"), [
        'import XOptional from "./XOptional";',
        'type Props = InstanceType<typeof XOptional>["$props"];',
        "const maybe = undefined as string | undefined;",
        "export const unset: Props = { count: 1, label: maybe, size: undefined };",
        "export const set: Props = { count: 1, label: \"Name\", size: \"sm\" };",
        "// @ts-expect-error outside the declared type",
        "export const outside: Props = { count: 1, size: \"lg\" };",
        "",
      ].join("\n"));
      await run("corepack", [
        "pnpm", "exec", "tsc", "--ignoreConfig", "--noEmit", "--strict", "--exactOptionalPropertyTypes", "--skipLibCheck",
        "--target", "ES2023", "--module", "ESNext", "--moduleResolution", "Bundler", "--lib", "ES2023,DOM",
        join(directory, "consumer.ts"),
      ], { cwd: packageRoot, shell: process.platform === "win32" }).catch((error: { stdout?: string; stderr?: string }) => {
        throw new Error(`Consumer typecheck failed.\n${error.stdout ?? ""}${error.stderr ?? ""}`, { cause: error });
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps Vue's modelValue API while binding a native root through its DOM events", () => {
    const outputs = generated(componentSource(
      "x-field",
      '<prop name="value" type="string">Value.</prop>',
      '<input :value="value">',
    ));
    const vue = outputs.get("vue/XField.vue")!;
    compileVue(vue, "XField.vue");
    assert.match(vue, /modelValue: \{ type: null as unknown as PropType<string \| null \| undefined> \}/);
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
    assert.match(vue, /anchor: \{ type: null as unknown as PropType<'start' \| 'end' \| null \| undefined> \}/);
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
    assert.match(vue, /as: \{ type: null as unknown as PropType<'button' \| 'a' \| undefined>, default: 'button' \}/);
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

  it("prunes directly compiled numeric updates by their static dependencies", async () => {
    const module = generated(`<template component="demo-split" status="experimental" summary="Split state.">
      <defs>
        <state name="left" :value="1"></state>
        <state name="right" :value="10"></state>
        <computed name="left1" from="left + 1"></computed>
        <computed name="left2" from="left1 + 1"></computed>
        <computed name="left3" from="left2 + 1"></computed>
        <computed name="total" from="left3 + right"></computed>
        <handler name="increaseLeft"><set name="left" :value="left + 1"></set></handler>
        <handler name="increaseRight"><set name="right" :value="right + 1"></set></handler>
      </defs>
      <section><button on:click="increaseLeft"><output $value="left3"></output></button><button on:click="increaseRight"><output $value="total"></output></button></section>
    </template>`).get("vanilla/DemoSplit.js")!;

    assert.doesNotMatch(module, /@nextwebwg\/html-next\/runtime/);
    assert.match(module, /let dirty = 0/);
    assert.match(module, /if \(changed & 1\)/);
    assert.match(module, /changed \|= 4/);
    assert.match(module, /if \(changed & 16\) element1\.textContent = String\(computed4\)/);
    await transform(module, { loader: "js" });
  });

  it("removes unused direct numeric branches from generated output", async () => {
    const module = generated(`<template component="demo-live" status="experimental" summary="Live direct branch.">
      <defs>
        <state name="left" :value="1"></state>
        <state name="right" :value="10"></state>
        <computed name="visible" from="right + 1"></computed>
        <computed name="unused1" from="left + 1"></computed>
        <computed name="unused2" from="unused1 + 1"></computed>
        <computed name="unused3" from="unused2 + 1"></computed>
        <handler name="increaseLeft"><set name="left" :value="left + 1"></set></handler>
        <handler name="increaseRight"><set name="right" :value="right + 1"></set></handler>
      </defs>
      <section><button on:click="increaseLeft"></button><button on:click="increaseRight"><output $value="visible"></output></button></section>
    </template>`).get("vanilla/DemoLive.js")!;

    assert.match(module, /computed2/);
    assert.doesNotMatch(module, /computed3|computed4|computed5/);
    assert.doesNotMatch(module, /state0|handler0/);
    assert.match(module, /state1|handler1/);
    assert.doesNotMatch(module, /let dirty = 0/);
    await transform(module, { loader: "js" });
  });

  it("suppresses repeated direct rounded DOM output", async () => {
    const module = generated(`<template component="demo-round" status="experimental" summary="Rounded direct value.">
      <defs>
        <state name="position" :value="0"></state>
        <computed name="bucket" from="round(position)"></computed>
        <handler name="advance"><set name="position" :value="position + 0.1"></set></handler>
      </defs>
      <button on:click="advance"><output $value="bucket"></output></button>
    </template>`).get("vanilla/DemoRound.js")!;

    assert.match(module, /let rendered0 = computed1/);
    assert.match(module, /!Object\.is\(rendered0, computed1\)/);
    await transform(module, { loader: "js" });
  });

  it("gates only stabilizing direct bindings in a mixed output", async () => {
    const module = generated(`<template component="demo-mixed" status="experimental" summary="Mixed direct value.">
      <defs>
        <state name="position" :value="0"></state>
        <computed name="bucket" from="round(position)"></computed>
        <handler name="advance"><set name="position" :value="position + 0.1"></set></handler>
      </defs>
      <button on:click="advance"><output $value="position"></output><output $value="bucket"></output></button>
    </template>`).get("vanilla/DemoMixed.js")!;

    assert.doesNotMatch(module, /rendered0/);
    assert.match(module, /let rendered1;/);
    assert.match(module, /!Object\.is\(rendered1, computed1\)/);
    await transform(module, { loader: "js" });
  });

  it("compiles numeric data attributes with the direct native emitter", async () => {
    const module = generated(`<template component="demo-data" status="experimental" summary="Direct data binding.">
      <defs>
        <state name="position" :value="0"></state>
        <computed name="bucket" from="round(position)"></computed>
        <handler name="advance"><set name="position" :value="position + 0.1"></set></handler>
      </defs>
      <button on:click="advance" :data-bucket="bucket"><output $value="position"></output></button>
    </template>`).get("vanilla/DemoData.js")!;

    assert.doesNotMatch(module, /@nextwebwg\/html-next\/runtime/);
    assert.match(module, /setAttribute\("data-bucket", String\(computed1\)\)/);
    assert.match(module, /!Object\.is\(rendered0, computed1\)/);
    await transform(module, { loader: "js" });
  });

  it("compiles numeric ARIA attributes with the direct native emitter", async () => {
    const module = generated(`<template component="demo-aria" status="experimental" summary="Direct ARIA binding.">
      <defs>
        <state name="position" :value="0"></state>
        <computed name="bucket" from="round(position)"></computed>
        <handler name="advance"><set name="position" :value="position + 0.1"></set></handler>
      </defs>
      <button on:click="advance" role="progressbar" :aria-valuenow="position" :aria-valuetext="bucket"><output $value="position"></output></button>
    </template>`).get("vanilla/DemoAria.js")!;

    assert.doesNotMatch(module, /@nextwebwg\/html-next\/runtime/);
    assert.match(module, /setAttribute\("aria-valuenow", String\(state0\)\)/);
    assert.match(module, /setAttribute\("aria-valuetext", String\(computed1\)\)/);
    await transform(module, { loader: "js" });
  });

  it("compiles numeric ordinary HTML attributes with the direct native emitter", async () => {
    const module = generated(`<template component="demo-title" status="experimental" summary="Direct HTML attribute binding.">
      <defs>
        <state name="position" :value="0"></state>
        <computed name="bucket" from="round(position)"></computed>
        <handler name="advance"><set name="position" :value="position + 0.1"></set></handler>
      </defs>
      <button on:click="advance" :title="bucket"><output $value="position"></output></button>
    </template>`).get("vanilla/DemoTitle.js")!;

    assert.doesNotMatch(module, /@nextwebwg\/html-next\/runtime/);
    assert.match(module, /setAttribute\("title", String\(computed1\)\)/);
    await transform(module, { loader: "js" });
  });

  it("compiles numeric native HTML properties with the direct emitter", async () => {
    const module = generated(`<template component="demo-value" status="experimental" summary="Direct HTML property binding.">
      <defs>
        <state name="position" :value="0"></state>
        <computed name="bucket" from="round(position)"></computed>
        <handler name="advance"><set name="position" :value="position + 0.1"></set></handler>
      </defs>
      <button on:click="advance"><input type="number" .value="bucket"><output $value="position"></output></button>
    </template>`).get("vanilla/DemoValue.js")!;

    assert.doesNotMatch(module, /@nextwebwg\/html-next\/runtime/);
    assert.match(module, /element0\["value"\] = computed1/);
    await transform(module, { loader: "js" });
  });

  it("compiles primitive boolean state, attributes, and properties with the direct emitter", async () => {
    const module = generated(`<template component="demo-toggle" status="experimental" summary="Direct primitive toggle.">
      <defs>
        <state name="open" :value="false"></state>
        <computed name="closed" from="not open"></computed>
        <handler name="toggle"><set name="open" :value="not open"></set></handler>
      </defs>
      <button on:click="toggle" :aria-expanded="open" :hidden="closed"><input type="checkbox" .checked="open"><output $value="closed"></output></button>
    </template>`).get("vanilla/DemoToggle.js")!;

    assert.doesNotMatch(module, /@nextwebwg\/html-next\/runtime/);
    assert.match(module, /!Boolean\(state0\)/);
    assert.match(module, /setAttribute\("aria-expanded", String\(state0\)\)/);
    assert.match(module, /computed1 \? element\.setAttribute\("hidden", ""\) : element\.removeAttribute\("hidden"\)/);
    assert.match(module, /element0\["checked"\] = state0/);
    await transform(module, { loader: "js" });
  });

  it("compiles primitive class tokens with the direct emitter", async () => {
    const module = generated(`<template component="demo-class-toggle" status="experimental" summary="Direct primitive class toggle.">
      <defs>
        <state name="open" :value="false"></state>
        <handler name="toggle"><set name="open" :value="not open"></set></handler>
      </defs>
      <button on:click="toggle" class:open="open"><output $value="open"></output></button>
    </template>`).get("vanilla/DemoClassToggle.js")!;

    assert.doesNotMatch(module, /@nextwebwg\/html-next\/runtime/);
    assert.match(module, /classList\.toggle\("open", Boolean\(state0\)\)/);
    await transform(module, { loader: "js" });
  });

  it("compiles primitive HTML style values with the direct emitter", async () => {
    const module = generated(`<template component="demo-style-counter" status="experimental" summary="Direct primitive style counter.">
      <defs>
        <state name="count" :value="0"></state>
        <handler name="increment"><set name="count" :value="count + 1"></set></handler>
      </defs>
      <button on:click="increment" style:--count="count"><output $value="count"></output></button>
    </template>`).get("vanilla/DemoStyleCounter.js")!;

    assert.doesNotMatch(module, /@nextwebwg\/html-next\/runtime/);
    assert.match(module, /style\.setProperty\("--count", String\(state0\)\)/);
    await transform(module, { loader: "js" });
  });

  it("compiles primitive SVG style values with the direct emitter", async () => {
    const module = generated(`<template component="demo-svg-style-counter" status="experimental" summary="Direct primitive SVG style counter.">
      <defs>
        <state name="count" :value="0"></state>
        <handler name="increment"><set name="count" :value="count + 1"></set></handler>
      </defs>
      <button on:click="increment"><svg style:--count="count"><text>Chart</text></svg><output $value="count"></output></button>
    </template>`).get("vanilla/DemoSvgStyleCounter.js")!;

    assert.doesNotMatch(module, /@nextwebwg\/html-next\/runtime/);
    assert.match(module, /style\.setProperty\("--count", String\(state0\)\)/);
    await transform(module, { loader: "js" });
  });

  it("compiles direct text input bindings with the native dirty-value guard", async () => {
    const module = generated(`<template component="demo-bound-text" status="experimental" summary="Direct native text binding.">
      <defs><state name="draft" :value="'Ready'"></state></defs>
      <section><label>Draft <input type="text" bind:value="draft"></label><output $value="draft"></output></section>
    </template>`).get("vanilla/DemoBoundText.js")!;

    assert.doesNotMatch(module, /@nextwebwg\/html-next\/runtime/);
    assert.match(module, /if \(element1\.value !== state0\) element1\.value = state0/);
    assert.match(module, /element1\.addEventListener\("input", binding0\)/);
    await transform(module, { loader: "js" });
  });

  it("keeps numeric two-way controls on the live runtime", () => {
    const module = generated(`<template component="demo-bound-number" status="experimental" summary="Numeric binding fallback.">
      <defs><state name="count" :value="0"></state></defs>
      <section><input type="number" bind:value="count"><output $value="count"></output></section>
    </template>`).get("vanilla/DemoBoundNumber.js")!;

    assert.match(module, /@nextwebwg\/html-next\/runtime/);
  });

  it("compiles direct checkbox bindings with native checked synchronization", async () => {
    const module = generated(`<template component="demo-bound-check" status="experimental" summary="Direct native checkbox binding.">
      <defs><state name="done" :value="false"></state></defs>
      <section><input type="checkbox" bind:checked="done"><output $value="done"></output></section>
    </template>`).get("vanilla/DemoBoundCheck.js")!;

    assert.doesNotMatch(module, /@nextwebwg\/html-next\/runtime/);
    assert.match(module, /if \(element0\.checked !== state0\) element0\.checked = state0/);
    assert.match(module, /element0\.addEventListener\("change", binding0\)/);
    await transform(module, { loader: "js" });
  });

  it("keeps radio two-way controls on the live runtime", () => {
    const module = generated(`<template component="demo-bound-radio" status="experimental" summary="Radio binding fallback.">
      <defs><state name="selected" :value="false"></state></defs>
      <section><input type="radio" bind:checked="selected"><output $value="selected"></output></section>
    </template>`).get("vanilla/DemoBoundRadio.js")!;

    assert.match(module, /@nextwebwg\/html-next\/runtime/);
  });

  it("compiles direct textarea and single-select bindings", async () => {
    const module = generated(`<template component="demo-bound-choice" status="experimental" summary="Direct native choice bindings.">
      <defs><state name="choice" :value="'one'"></state></defs>
      <section><textarea bind:value="choice"></textarea><select bind:value="choice"><option value="one">One</option><option value="two">Two</option></select><output $value="choice"></output></section>
    </template>`).get("vanilla/DemoBoundChoice.js")!;

    assert.doesNotMatch(module, /@nextwebwg\/html-next\/runtime/);
    assert.match(module, /element0\.addEventListener\("input", binding0\)/);
    assert.match(module, /element1\.addEventListener\("change", binding1\)/);
    await transform(module, { loader: "js" });
  });

  it("keeps multi-select bindings on the live runtime", () => {
    const module = generated(`<template component="demo-bound-many" status="experimental" summary="Multi-select binding fallback.">
      <defs><state name="choice" :value="'one'"></state></defs>
      <section><select multiple bind:value="choice"><option value="one">One</option><option value="two">Two</option></select><output $value="choice"></output></section>
    </template>`).get("vanilla/DemoBoundMany.js")!;

    assert.match(module, /@nextwebwg\/html-next\/runtime/);
  });

  it("compiles direct range bindings with native numeric synchronization", async () => {
    const module = generated(`<template component="demo-bound-range" status="experimental" summary="Direct native range binding.">
      <defs><state name="position" :value="0"></state></defs>
      <section><input type="range" min="0" max="100" bind:value="position"><output $value="position"></output></section>
    </template>`).get("vanilla/DemoBoundRange.js")!;

    assert.doesNotMatch(module, /@nextwebwg\/html-next\/runtime/);
    assert.match(module, /if \(element0\.value !== String\(state0\)\) element0\.value = String\(state0\)/);
    assert.match(module, /const next = element0\.valueAsNumber/);
    await transform(module, { loader: "js" });
  });

  it("compiles static prevent and stop handlers with native event calls", async () => {
    const module = generated(`<template component="demo-event-modifier" status="experimental" summary="Direct native event modifiers.">
      <defs><state name="count" :value="0"></state><handler name="increment"><set name="count" :value="count + 1"></set></handler></defs>
      <section><button on:click.prevent.stop="increment"><output $value="count"></output></button></section>
    </template>`).get("vanilla/DemoEventModifier.js")!;

    assert.doesNotMatch(module, /@nextwebwg\/html-next\/runtime/);
    assert.match(module, /event\.preventDefault\(\)/);
    assert.match(module, /event\.stopPropagation\(\)/);
    await transform(module, { loader: "js" });
  });

  it("compiles static self handlers with a native target identity guard", async () => {
    const module = generated(`<template component="demo-event-self" status="experimental" summary="Direct native self modifier.">
      <defs><state name="count" :value="0"></state><handler name="increment"><set name="count" :value="count + 1"></set></handler></defs>
      <section><button on:click.self="increment"><span>Inner</span><output $value="count"></output></button></section>
    </template>`).get("vanilla/DemoEventSelf.js")!;

    assert.doesNotMatch(module, /@nextwebwg\/html-next\/runtime/);
    assert.match(module, /if \(event\.target !== element0\) return/);
    await transform(module, { loader: "js" });
  });

  it("compiles static filtered handlers with native event guards", async () => {
    const module = generated(`<template component="demo-event-filter" status="experimental" summary="Direct native event filter.">
      <defs><state name="count" :value="0"></state><handler name="increment"><set name="count" :value="count + 1"></set></handler></defs>
      <section><button on:keydown.enter.ctrl.exact.self.prevent.stop="increment"><span>Inner</span><output $value="count"></output></button></section>
    </template>`).get("vanilla/DemoEventFilter.js")!;

    assert.doesNotMatch(module, /@nextwebwg\/html-next\/runtime/);
    assert.match(module, /event instanceof KeyboardEvent && event\.key !== "Enter"/);
    assert.match(module, /if \(!event\.ctrlKey\) return/);
    assert.match(module, /if \(event\.shiftKey\) return/);
    assert.match(module, /if \(event\.target !== element0\) return/);
    assert.match(module, /event\.preventDefault\(\)/);
    assert.match(module, /event\.stopPropagation\(\)/);
    await transform(module, { loader: "js" });
  });

  it("compiles static capture and passive listeners with native options", async () => {
    const module = generated(`<template component="demo-event-options" status="experimental" summary="Direct native event options.">
      <defs><state name="count" :value="0"></state><handler name="increment"><set name="count" :value="count + 1"></set></handler></defs>
      <section><button on:click.capture.passive.stop="increment"><span>Inner</span><output $value="count"></output></button></section>
    </template>`).get("vanilla/DemoEventOptions.js")!;

    assert.doesNotMatch(module, /@nextwebwg\/html-next\/runtime/);
    assert.match(module, /addEventListener\("click", event0, \{ capture: true, passive: true \}\)/);
    assert.match(module, /event\.stopPropagation\(\)/);
    await transform(module, { loader: "js" });
  });

  it("compiles static once listeners through the generated lifecycle coordinator", async () => {
    const module = generated(`<template component="demo-event-once" status="experimental" summary="Native once fallback.">
      <defs><state name="count" :value="0"></state><handler name="increment"><set name="count" :value="count + 1"></set></handler></defs>
      <button on:keydown.enter.once="increment"><output $value="count"></output></button>
    </template>`).get("vanilla/DemoEventOnce.js")!;

    assert.doesNotMatch(module, /@nextwebwg\/html-next\/runtime/);
    assert.match(module, /manageGeneratedLifecycle/);
    assert.match(module, /addEventListener\("keydown", event0, \{ once: true \}\)/);
    assert.match(module, /removeEventListener\("keydown", event0\)/);
    await transform(module, { loader: "js" });
  });

  it("rejects deferred declarative connection handlers", () => {
    for (const binding of ["on:connect", "on:disconnect", "on:connect.once.exact.prevent.capture.enter.left", "on:disconnect.passive.stop"]) {
      assert.throws(() => generated(`<template component="demo-event-lifecycle" status="experimental" summary="Deferred lifecycle.">
        <defs><handler name="increment"></handler></defs>
        <button ${binding}="increment"></button>
      </template>`), /HT010/);
    }
  });

  it("compiles static state-derived primitive event dispatch through generated runtime validation", async () => {
    const module = generated(`<template component="demo-event-dispatch" status="experimental" summary="Direct declared event dispatch.">
      <defs>
        <event name="saved" type="number" bubbles="false" composed="false" cancelable="true"></event>
        <state name="count" :value="0"></state>
        <handler name="save"><set name="count" :value="count + 1"></set><dispatch event="saved" :value="count"></dispatch></handler>
      </defs>
      <button on:click="save">Save</button>
    </template>`).get("vanilla/DemoEventDispatch.js")!;

    assert.doesNotMatch(module, /@nextwebwg\/html-next\/runtime/);
    assert.match(module, /dispatchGeneratedEvent/);
    assert.match(module, /name: "saved", type: "number", detail: state0, bubbles: false, composed: false, cancelable: true/);
    await transform(module, { loader: "js" });
  });

  it("compiles state-only boolean handler guards while preserving subsequent steps", async () => {
    const module = generated(`<template component="demo-guarded-handler" status="experimental" summary="Direct guarded handler.">
      <defs>
        <event name="saved" type="number"></event>
        <state name="enabled" :value="true"></state>
        <state name="count" :value="0"></state>
        <handler name="advance"><set name="count" :value="count + 1" $if="enabled"></set><dispatch event="saved" :value="count" $if="enabled"></dispatch><set name="enabled" :value="not enabled"></set></handler>
      </defs>
      <button on:click="advance"><output $value="count"></output></button>
    </template>`).get("vanilla/DemoGuardedHandler.js")!;

    assert.doesNotMatch(module, /@nextwebwg\/html-next\/runtime/);
    assert.match(module, /if \(state0\) \{/);
    assert.match(module, /const next0 = state1 \+ 1/);
    assert.match(module, /detail: state1/);
    assert.match(module, /const next2 = !Boolean\(state0\)/);
    await transform(module, { loader: "js" });
  });

  it("pulls static primitive computed handler guards before each guarded step", async () => {
    const module = generated(`<template component="demo-computed-guard" status="experimental" summary="Computed guard direct path.">
      <defs>
        <state name="count" :value="0"></state>
        <state name="hits" :value="0"></state>
        <computed name="even" from="count % 2 = 0"></computed>
        <handler name="advance"><set name="count" :value="count + 1"></set><set name="hits" :value="hits + 1" $if="even"></set></handler>
      </defs>
      <button on:click="advance"><output $value="count"></output><output $value="hits"></output></button>
    </template>`).get("vanilla/DemoComputedGuard.js")!;

    assert.doesNotMatch(module, /@nextwebwg\/html-next\/runtime/);
    assert.match(module, /computed2 = \(\(state0 % 2\) === 0\);[^]*if \(computed2\) \{/);
    await transform(module, { loader: "js" });
  });

  it("compiles static refs with native validation and focus handler steps", async () => {
    const module = generated(`<template component="demo-ref-action" status="experimental" summary="Direct static ref action.">
      <defs>
        <state name="count" :value="0"></state>
        <handler name="submit"><validate target="form"></validate><focus ref="field"></focus><set name="count" :value="count + 1"></set></handler>
      </defs>
      <section><form $ref="form"><input required $ref="field"></form><button on:click="submit">Submit</button><output $value="count"></output></section>
    </template>`).get("vanilla/DemoRefAction.js")!;

    assert.doesNotMatch(module, /@nextwebwg\/html-next\/runtime/);
    assert.match(module, /element0\.reportValidity\?\.\(\);/);
    assert.match(module, /element1\.focus\(\);/);
    await transform(module, { loader: "js" });
  });

  it("compiles dependency-free primitive `$value` beside dynamic direct output", async () => {
    const module = generated(`<template component="demo-literal-text" status="experimental" summary="Direct literal text.">
      <defs><state name="count" :value="0"></state><handler name="increment"><set name="count" :value="count + 1"></set></handler></defs>
      <section><output class="status" $value="'Ready'"></output><button on:click="increment"><output $value="count"></output></button></section>
    </template>`).get("vanilla/DemoLiteralText.js")!;

    assert.doesNotMatch(module, /@nextwebwg\/html-next\/runtime/);
    assert.match(module, /element0\.textContent = String\("Ready"\);/);
    await transform(module, { loader: "js" });
  });

  it("compiles dependency-free primitive native bindings beside dynamic direct output", async () => {
    const module = generated(`<template component="demo-literal-native" status="experimental" summary="Direct literal native bindings.">
      <defs><state name="count" :value="0"></state><handler name="increment"><set name="count" :value="count + 1"></set></handler></defs>
      <section :data-status="'ready'" :aria-hidden="false" :hidden="true" class:fixed="true" style:--gap="4"><input .value="'Fixed'"><button on:click="increment"><output $value="count"></output></button></section>
    </template>`).get("vanilla/DemoLiteralNative.js")!;

    assert.doesNotMatch(module, /@nextwebwg\/html-next\/runtime/);
    assert.match(module, /setAttribute\("data-status", String\("ready"\)\)/);
    assert.match(module, /setAttribute\("aria-hidden", String\(false\)\)/);
    assert.match(module, /true \? element\.setAttribute\("hidden", ""\) : element\.removeAttribute\("hidden"\)/);
    assert.match(module, /classList\.toggle\("fixed", Boolean\(true\)\)/);
    assert.match(module, /style\.setProperty\("--gap", String\(4\)\)/);
    assert.match(module, /\["value"\] = "Fixed"/);
    await transform(module, { loader: "js" });
  });

  it("initializes transitively constant direct computeds during construction", async () => {
    const module = generated(`<template component="demo-static-computed" status="experimental" summary="Static computed direct construction.">
      <defs>
        <event name="saved" type="string"></event>
        <state name="count" :value="0"></state>
        <computed name="prefix" from="'Ready'"></computed>
        <computed name="label" from="format('%s!', prefix)"></computed>
        <handler name="increment"><set name="count" :value="count + 1"></set></handler>
        <handler name="save"><dispatch event="saved" :value="label"></dispatch></handler>
      </defs>
      <section :data-status="label" class:ready="label = 'Ready!'" style:--label="prefix"><input .value="label"><output class="status" $value="label"></output><button on:click="increment"><output $value="count"></output></button><button on:click="save">Save</button></section>
    </template>`).get("vanilla/DemoStaticComputed.js")!;

    assert.doesNotMatch(module, /@nextwebwg\/html-next\/runtime/);
    assert.doesNotMatch(module, /\bcomputed[12]\b/);
    assert.match(module, /setAttribute\("data-status", String\("Ready!"\)\)/);
    assert.match(module, /classList\.toggle\("ready", Boolean\(\("Ready!" === "Ready!"\)\)\)/);
    assert.match(module, /style\.setProperty\("--label", String\("Ready"\)\)/);
    assert.match(module, /\["value"\] = "Ready!"/);
    assert.match(module, /element1\.textContent = String\("Ready!"\);/);
    await transform(module, { loader: "js" });
  });

  it("pulls static primitive computed event detail through the generated dispatch boundary", async () => {
    const module = generated(`<template component="demo-computed-event-dispatch" status="experimental" summary="Direct computed declared event dispatch.">
      <defs>
        <event name="saved" type="number" bubbles="false" composed="false" cancelable="true"></event>
        <state name="count" :value="0"></state>
        <computed name="savedValue" from="count * 2"></computed>
        <handler name="save"><set name="count" :value="count + 1"></set><dispatch event="saved" :value="savedValue"></dispatch></handler>
      </defs>
      <button on:click="save">Save <output $value="savedValue"></output></button>
    </template>`).get("vanilla/DemoComputedEventDispatch.js")!;

    assert.doesNotMatch(module, /@nextwebwg\/html-next\/runtime/);
    assert.doesNotMatch(module, /refreshComputedForDispatch/);
    assert.match(module, /state0 = next0;[^]*computed1 = \(state0 \* 2\);[^]*dispatchGeneratedEvent/);
    assert.match(module, /name: "saved", type: "number", detail: computed1, bubbles: false, composed: false, cancelable: true/);
    await transform(module, { loader: "js" });
  });

  it("compiles a static primitive `$value` expression without the live runtime", async () => {
    const module = generated(`<template component="demo-inline-expression" status="experimental" summary="Direct inline text expression.">
      <defs>
        <state name="count" :value="0"></state>
        <handler name="increment"><set name="count" :value="count + 1"></set></handler>
      </defs>
      <button on:click="increment"><output $value="count + 1"></output></button>
    </template>`).get("vanilla/DemoInlineExpression.js")!;

    assert.doesNotMatch(module, /@nextwebwg\/html-next\/runtime/);
    assert.match(module, /textContent = String\(\(state0 \+ 1\)\)/);
    await transform(module, { loader: "js" });
  });

  it("compiles static primitive attribute, property, class, and style expressions directly", async () => {
    const module = generated(`<template component="demo-inline-attributes" status="experimental" summary="Direct inline native expressions.">
      <defs>
        <state name="count" :value="0"></state>
        <handler name="increment"><set name="count" :value="count + 1"></set></handler>
      </defs>
      <section :data-count="count + 1" class:zero="count = 0" style:--count="count + 1"><button on:click="increment">Advance</button><input type="number" .value="count + 1"></section>
    </template>`).get("vanilla/DemoInlineAttributes.js")!;

    assert.doesNotMatch(module, /@nextwebwg\/html-next\/runtime/);
    assert.match(module, /setAttribute\("data-count", String\(\(state0 \+ 1\)\)\)/);
    assert.match(module, /classList\.toggle\("zero", Boolean\(\(state0 === 0\)\)\)/);
    assert.match(module, /style\.setProperty\("--count", String\(\(state0 \+ 1\)\)\)/);
    assert.match(module, /\["value"\] = \(state0 \+ 1\)/);
    await transform(module, { loader: "js" });
  });

  it("compiles dependency-free primitive `$value` expressions as direct text", async () => {
    const module = generated(`<template component="demo-static-directive" status="experimental" summary="Static directive text.">
      <defs>
        <state name="count" :value="0"></state>
        <handler name="increment"><set name="count" :value="count + 1"></set></handler>
      </defs>
      <button on:click="increment"><output $value="'fixed'"></output></button>
    </template>`).get("vanilla/DemoStaticDirective.js")!;

    assert.doesNotMatch(module, /@nextwebwg\/html-next\/runtime/);
    assert.match(module, /textContent = String\("fixed"\)/);
    await transform(module, { loader: "js" });
  });

  it("keeps a type-incompatible direct primitive state on the conforming runtime", () => {
    const module = generated(`<template component="demo-inert" status="experimental" summary="Typed direct primitive fallback.">
      <defs>
        <state name="open" type="string" :value="false"></state>
        <handler name="toggle"><set name="open" :value="not open"></set></handler>
      </defs>
      <button on:click="toggle" :aria-expanded="open"><output $value="open"></output></button>
    </template>`).get("vanilla/DemoInert.js")!;

    assert.match(module, /@nextwebwg\/html-next\/runtime/);
  });

  it("keeps mutable typed numeric state on the conforming runtime", () => {
    const module = generated(`<template component="demo-typed-number" status="experimental" summary="Typed numeric state.">
      <defs><state name="count" type="number" :value="1"></state><handler name="divide"><set name="count" :value="count / 0"></set></handler></defs>
      <button on:click="divide"><output $value="count"></output></button>
    </template>`).get("vanilla/DemoTypedNumber.js")!;

    assert.match(module, /@nextwebwg\/html-next\/runtime/);
  });

  it("includes set value dependencies even when they are not rendered", async () => {
    const module = generated(`<template component="demo-set-input" status="experimental" summary="Set input dependency.">
      <defs><state name="count" :value="0"></state><state name="snapshot" :value="0"></state><handler name="save"><set name="snapshot" :value="count + 1"></set></handler></defs>
      <button on:click="save"><output $value="snapshot"></output></button>
    </template>`).get("vanilla/DemoSetInput.js")!;

    assert.doesNotMatch(module, /@nextwebwg\/html-next\/runtime/);
    assert.match(module, /let state0 = 0/);
    assert.match(module, /const next0 = \(state0 \+ 1\)/);
    await transform(module, { loader: "js" });
  });

  it("refreshes a computed before a later set reads it", async () => {
    const module = generated(`<template component="demo-sequential-sets" status="experimental" summary="Sequential sets.">
      <defs><state name="count" :value="0"></state><state name="snapshot" :value="0"></state><computed name="double" from="count * 2"></computed><handler name="advance"><set name="count" :value="count + 1"></set><set name="snapshot" :value="double"></set></handler></defs>
      <button on:click="advance"><output $value="snapshot"></output></button>
    </template>`).get("vanilla/DemoSequentialSets.js")!;

    assert.doesNotMatch(module, /@nextwebwg\/html-next\/runtime/);
    assert.match(module, /state0 = next0;[^]*computed2 = \(state0 \* 2\);[^]*const next1 = computed2/);
    await transform(module, { loader: "js" });
  });

  it("keeps a state initializer that reads a computed declaration on the live runtime", () => {
    const module = generated(`<template component="demo-initial-order" status="experimental" summary="State initialization order fallback.">
      <defs>
        <state name="count" :value="0"></state>
        <computed name="derived" from="count + 1"></computed>
        <state name="snapshot" :value="derived"></state>
        <handler name="increment"><set name="count" :value="count + 1"></set></handler>
      </defs>
      <button on:click="increment"><output $value="snapshot"></output></button>
    </template>`).get("vanilla/DemoInitialOrder.js")!;

    assert.match(module, /@nextwebwg\/html-next\/runtime/);
  });

  it("compiles static string modes to direct native text, attributes, and properties", async () => {
    const module = generated(`<template component="demo-tabs" status="experimental" summary="Direct string tabs.">
      <defs>
        <state name="tab" :value="'one'"></state>
        <handler name="showOne"><set name="tab" :value="'one'"></set></handler>
        <handler name="showTwo"><set name="tab" :value="'two'"></set></handler>
      </defs>
      <section :data-tab="tab" :title="tab"><button on:click="showOne">One</button><button on:click="showTwo">Two</button><input .value="tab"><output $value="tab"></output></section>
    </template>`).get("vanilla/DemoTabs.js")!;

    assert.doesNotMatch(module, /@nextwebwg\/html-next\/runtime/);
    assert.match(module, /let state0 = "one"/);
    assert.match(module, /setAttribute\("data-tab", String\(state0\)\)/);
    assert.match(module, /element2\["value"\] = state0/);
    await transform(module, { loader: "js" });
  });

  it("keeps string URL attributes on the sanitizing live runtime", () => {
    const module = generated(`<template component="demo-link" status="experimental" summary="String URL fallback.">
      <defs>
        <state name="destination" :value="'/start'"></state>
        <handler name="change"><set name="destination" :value="'javascript:alert(1)'"></set></handler>
      </defs>
      <a on:click="change" :href="destination"><output $value="destination"></output></a>
    </template>`).get("vanilla/DemoLink.js")!;

    assert.match(module, /@nextwebwg\/html-next\/runtime/);
  });

  it("compiles literal primitive format expressions to direct string concatenation", async () => {
    const module = generated(`<template component="demo-label" status="experimental" summary="Direct formatted label.">
      <defs>
        <state name="count" :value="0"></state>
        <computed name="label" from="format('Step %s', count)"></computed>
        <handler name="increment"><set name="count" :value="count + 1"></set></handler>
      </defs>
      <button on:click="increment" :aria-label="label"><input .value="label"><output $value="label"></output></button>
    </template>`).get("vanilla/DemoLabel.js")!;

    assert.doesNotMatch(module, /@nextwebwg\/html-next\/runtime/);
    assert.match(module, /"Step " \+ String\(state0\) \+ ""/);
    await transform(module, { loader: "js" });
  });

  it("preserves missing format placeholders in the direct primitive subset", () => {
    const module = generated(`<template component="demo-missing-format" status="experimental" summary="Direct missing format placeholder.">
      <defs>
        <state name="count" :value="0"></state>
        <computed name="label" from="format('%s/%s', count)"></computed>
        <handler name="increment"><set name="count" :value="count + 1"></set></handler>
      </defs>
      <button on:click="increment"><output $value="label"></output></button>
    </template>`).get("vanilla/DemoMissingFormat.js")!;

    assert.doesNotMatch(module, /@nextwebwg\/html-next\/runtime/);
    assert.match(module, /String\(state0\) \+ "\/" \+ "%s"/);
  });

  it("retains the live runtime for ordinary SVG attributes that need name adjustment", () => {
    const module = generated(`<template component="demo-svg-bound" status="experimental" summary="Bound SVG attribute.">
      <defs>
        <state name="size" :value="24"></state>
        <handler name="grow"><set name="size" :value="size + 1"></set></handler>
      </defs>
      <button on:click="grow"><svg :viewBox="size"><path d="M0 0"></path></svg></button>
    </template>`).get("vanilla/DemoSvgBound.js")!;

    assert.match(module, /@nextwebwg\/html-next\/runtime/);
  });

  it("keeps numeric SVG data attributes on the direct native emitter", async () => {
    const module = generated(`<template component="demo-svg-data" status="experimental" summary="Direct SVG data binding.">
      <defs>
        <state name="size" :value="24"></state>
        <handler name="grow"><set name="size" :value="size + 1"></set></handler>
      </defs>
      <button on:click="grow"><svg :data-size="size"><path d="M0 0"></path></svg></button>
    </template>`).get("vanilla/DemoSvgData.js")!;

    assert.doesNotMatch(module, /@nextwebwg\/html-next\/runtime/);
    assert.match(module, /setAttribute\("data-size", String\(state0\)\)/);
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
    assert.match(module, /manageGeneratedProp/);
    await transform(module, { loader: "js" });
  });

  it("compiles a scalar native property prop with the compact generated boundary", async () => {
    const module = generated(componentSource(
      "demo-prop-value",
      `<prop name="value" type="number" default="1">Value.</prop>`,
      `<input type="number" .value="value">`,
    )).get("vanilla/DemoPropValue.js")!;

    assert.match(module, /manageGeneratedProp\(/);
    assert.doesNotMatch(module, /@nextwebwg\/html-next\/runtime/);
    assert.match(module, /element\["value"\] = value;/);
    await transform(module, { loader: "js" });
  });

  it("keeps multi-prop native property bindings on the full runtime path", () => {
    const module = generated(componentSource(
      "demo-prop-values",
      `<prop name="value" type="number" default="1">Value.</prop><prop name="label" type="string" default="Ready">Label.</prop>`,
      `<section><input type="number" .value="value" :data-label="label"></section>`,
    )).get("vanilla/DemoPropValues.js")!;

    assert.match(module, /@nextwebwg\/html-next\/runtime/);
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

  it("compiles a read-only primitive reactive leaf without the full runtime", async () => {
    const module = generated(`<template component="demo-derived" status="experimental" summary="Derived output.">
      <defs><state name="count" :value="0"></state></defs>
      <output $value="count + 1"></output>
    </template>`).get("vanilla/DemoDerived.js")!;

    assert.doesNotMatch(module, /@nextwebwg\/html-next\/runtime/);
    assert.doesNotMatch(module, /\bstate0\b/);
    assert.match(module, /element\.textContent = String\(\(0 \+ 1\)\);/);
    await transform(module, { loader: "js" });
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
