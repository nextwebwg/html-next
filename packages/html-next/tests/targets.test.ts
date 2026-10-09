import assert from "node:assert/strict";
import "@formatjs/intl-durationformat/polyfill.js";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, it } from "vitest";

import { compileScript, compileTemplate, parse as parseVue } from "@vue/compiler-sfc";
import { build, transform, type Plugin } from "esbuild";
import { createSSRApp, type Component } from "vue";
import { renderToString } from "@vue/server-renderer";
import { createElement } from "react";
import { renderToString as renderReactToString } from "react-dom/server";
import { JSDOM } from "jsdom";

import { generateSvelteOutput } from "../src/targets/svelte.js";
import { generateComponent, generateReactComponent, generateVueComponent, reactRenderArtifact, vueControlArtifact, vueHostArtifact, vueHtmlArtifact, vuePropsArtifact } from "../src/generate.js";
import { parseComponent } from "../src/source-parser.js";
import { renderComponents } from "../src/server.js";
import { formattingSource } from "./formatting-fixture.js";

const fixtureUrl = new URL("./fixtures/x-button.html", import.meta.url);
const packageRoot = fileURLToPath(new URL("../", import.meta.url));

/** Resolves a converted component's shared helper imports to the modules a build ships beside it. */
const vueHelpers: Plugin = { name: "generated-helpers", setup(bundler) {
  const artifacts: Record<string, () => { readonly content: string }> = { host: vueHostArtifact, props: vuePropsArtifact, html: vueHtmlArtifact, control: vueControlArtifact, render: reactRenderArtifact };
  bundler.onResolve({ filter: /^\.\/(?:host|props|html|control|render)$/ }, (args) => ({ path: args.path.slice(2), namespace: "generated-helper" }));
  bundler.onLoad({ filter: /.*/, namespace: "generated-helper" }, (args) => ({ contents: artifacts[args.path]!().content, loader: args.path === "render" ? "tsx" : "ts", resolveDir: packageRoot }));
} };
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
    <prop name="size" type="keyword" values="sm, md" default="md">Size.</prop>
    <state type="boolean" name="open" value="false"></state>
    <state type="string" name="query" value=""></state>
    <computed name="count" from="$items.length"></computed>
    <event name="toggle" type="object({ open: boolean })"></event>
    <handler name="flip"><set name="open" expr:value="not $open"></set><dispatch event="toggle" expr:value="{ open: $open }"></dispatch></handler>
  </defs>
  <section class="panel" class:compact="$size = 'sm'" style:--gap="$size">
    <h2 $value="$label"></h2>
    <input $ref="search" bind:value="query">
    <button type="button" on:click="flip"><template $value="$open"></template></button>
    <ul $if="$open">
      <li $each="item, index of $items" $key="$item.id" $where="$item.done" $sort="item.name"><span $value="$item.name"></span></li>
    </ul>
    <template $match>
      <small $when="$size = 'sm'">small</small>
      <span $else>regular</span>
    </template>
    <x-badge from:tone="$size"><slot name="badge">none</slot></x-badge>
    <slot></slot>
  </section>
  <style>
    :host { display: block; }
    :host-state([open]) .panel { outline: 1px solid; }
    :host([size="sm"]) h2 { font-size: small; }
    :slotted(p) { margin: 0; }
    x-badge { margin-inline: auto; }
  </style>
</template>`;

describe("official target compilers", () => {
  it("renders inline row paths without allocating a Vue component for each text node", async () => {
    let valueSource: string | undefined;
    for (const text of [undefined, "{$row.label}", "Hello  {$row.id}{$row.label}{$row.note}{$row.missing}!", "{$row.id}{$row.id}"]) {
      const inline = text !== undefined;
      const definition = parseComponent(`<template component="x-row-text"><defs>
        <state name="rows" type="list(object({ id: number, label: string, note: unknown, missing?: string }))" value="[{ id: 1, label: 'Ada', note: null }, { id: 2, label: 'Bea', note: '?' }]"></state>
        </defs><ul><li $each="row of $rows"><span${inline ? "" : ' $value="$row.label"'}>${text ?? ""}</span></li></ul></template>`);
      const source = generateVueComponent(definition);
      if (text === "{$row.label}") assert.equal(source, valueSource, "inline paths and $value must emit identical Vue code");
      else if (!inline) valueSource = source;
      const compiled = compileVue(source, "XRowText.vue");
      const bundle = await build({ stdin: { contents: compiled, loader: "ts", resolveDir: packageRoot },
        bundle: true, write: false, platform: "node", format: "cjs", packages: "external", plugins: [vueHelpers] });
      const module = { exports: {} as { default: Component } };
      new Function("require", "module", "exports", bundle.outputFiles[0]!.text)(createRequire(import.meta.url), module, module.exports);
      const app = createSSRApp(module.exports.default);
      let instances = 0;
      app.mixin({ beforeCreate() { instances++; } });
      const html = await renderToString(app);
      assert.equal(instances, 1, `${inline ? "inline" : "$value"}: row text needs no component instance`);
      assert.doesNotMatch(source, /RetainedInlineText|inlineTextSegment|\.join\(''\)/);
      // Template text follows Vue's whitespace handling: an authored run of spaces renders as one.
      const expected = text?.startsWith("Hello") ? "Hello 1Ada!Hello 2Bea?!" : text === "{$row.id}{$row.id}" ? "1122" : "AdaBea";
      assert.equal(new JSDOM(html).window.document.querySelector("ul")?.textContent, expected);
    }
  });
  it("shares formatter instances between generated Vue and React component instances", async () => {
    // Formatting appears only in the computed value, exercising late helper discovery too.
    const definition = parseComponent(`<template component="x-format-cache"><defs>
      <computed name="label" from="format(12, 'currency', { currency: 'USD' }, 'en-US')"></computed>
      </defs><p>{$label}</p></template>`);
    for (const target of ["vue", "react"] as const) {
      const generated = target === "vue" ? compileVue(generateVueComponent(definition), "XFormatCache.vue") : generateReactComponent(definition);
      const bundle = await build({ stdin: { contents: generated, loader: target === "vue" ? "ts" : "tsx", resolveDir: packageRoot },
        bundle: true, write: false, platform: "node", format: "cjs", packages: "external", plugins: [vueHelpers] });
      const module = { exports: {} as { default: Component & ((props: object) => ReturnType<typeof createElement>) } };
      new Function("require", "module", "exports", bundle.outputFiles[0]!.text)(createRequire(import.meta.url), module, module.exports);
      const constructor = Intl.NumberFormat;
      let count = 0;
      Intl.NumberFormat = new Proxy(constructor, { construct(ctor, args) { count++; return Reflect.construct(ctor, args); } });
      try {
        for (let i = 0; i < 3; i++) {
          const html = target === "vue" ? await renderToString(createSSRApp(module.exports.default))
            : renderReactToString(createElement(module.exports.default));
          assert.match(html, /\$12\.00/);
        }
        assert.equal(count, 1, `${target}: cache must outlive component setup/render`);
      } finally { Intl.NumberFormat = constructor; }
    }
  });
  it("renders Vue Intl expressions in Node with the same text as native SSR", async () => {
    const definition = parseComponent(formattingSource);
    const directory = await mkdtemp(join(packageRoot, ".vue-ssr-"));
    try {
      const artifacts = [...generateComponent(definition), vueHostArtifact()];
      for (const artifact of artifacts) {
        const file = join(directory, artifact.path);
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, artifact.content);
      }
      const source = artifacts.find((artifact) => artifact.path === "vue/XFormatting.vue")!.content;
      const parsed = parseVue(source, { filename: "XFormatting.vue" });
      assert.deepEqual(parsed.errors, []);
      const script = compileScript(parsed.descriptor, { id: "formatting", inlineTemplate: true, templateOptions: { ssr: true } });
      const bundle = await build({ stdin: { contents: script.content, loader: "ts", resolveDir: join(directory, "vue") },
        bundle: true, write: false, platform: "node", format: "cjs", packages: "external", loader: { ".css": "empty" }, plugins: [vueHelpers] });
      const module = { exports: {} as { default: Component } };
      new Function("require", "module", "exports", bundle.outputFiles[0]!.text)(createRequire(import.meta.url), module, module.exports);
      const [vue, native] = await Promise.all([
        renderToString(createSSRApp(module.exports.default)),
        renderComponents("<x-formatting></x-formatting>", { definitions: [definition] }),
      ]);
      const read = (html: string): unknown => {
        const dom = new JSDOM(html);
        try {
          const root = dom.window.document.querySelector("section")!;
          return { label: root.getAttribute("aria-label"), values: Object.fromEntries(Array.from(root.querySelectorAll("[data-format]"),
            (element) => [element.getAttribute("data-format"), element.textContent])) };
        } finally { dom.window.close(); }
      };
      assert.deepEqual(read(vue), read(native.html));
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it("compiles mixed inline text and CSS-derived local names in all targets", async () => {
    const definition = parseComponent(String.raw`<template component="x-inline"><defs>
      <state name="rows" type="list(object({ id: number, name: string }))" value="[{ id: 1, name: 'Ada' }]"></state>
      </defs><section><p>Total: {$rows.0.name} due today. $literal costs $1.15.</p>
      <table><tbody><tr $each="😀 of $rows" $key="$😀.id"><td>Hello {$😀.name}!</td></tr></tbody></table></section></template>`);
    const outputs = new Map(generateComponent(definition).map((artifact) => [artifact.path, artifact.content]));
    compileVue(outputs.get("vue/XInline.vue")!, "XInline.vue");
    await transform(generateReactComponent(definition), { loader: "tsx", format: "esm" });
    await transform(outputs.get("vanilla/XInline.js")!, { loader: "js", format: "esm" });
  });
  it("compiles dotted numeric references for Vue and vanilla", async () => {
    const outputs = generated(`<template component="x-indexed"><defs>
      <state name="items" type="list(object({ name: string }))" value="[{ name: 'Ada' }]"></state>
    </defs><output $value="$items.0.name"></output></template>`);
    const vue = outputs.get("vue/XIndexed.vue")!;
    const vanilla = outputs.get("vanilla/XIndexed.js")!;
    assert.match(vue, /\[0\]/);
    compileVue(vue, "XIndexed.vue");
    await transform(vanilla, { loader: "js", format: "esm" });
  });
  it("preserves nested permitted event values in generated targets", () => {
    const outputs = generated(`<template component="x-nested-event"><defs>
      <event name="change" type="object">
        <prop name="value" type="number" required></prop>
        <prop name="trigger" type="keyword" values="keyboard, pointer" required></prop>
      </event>
    </defs><output></output></template>`);
    const vanilla = outputs.get("vanilla/XNestedEvent.d.ts")!;
    const vue = outputs.get("vue/XNestedEvent.vue")!;
    assert.match(vanilla, /trigger: "keyboard" \| "pointer"/);
    assert.match(vue, /\['trigger'\] === 'keyboard'/);
    assert.match(vue, /\['trigger'\] === 'pointer'/);
    compileVue(vue, "XNestedEvent.vue");
  });

  for (const form of ["inline", "named"] as const) {
    it(`generates dependent Vue and vanilla props from a ${form} type`, async () => {
      const declaration = form === "inline"
        ? `<prop name="value">Value.<type from="type"><option value="text" type="string"></option><option value="number" type="number"></option></type></prop>`
        : `<type name="input-value" from="type"><option value="text" type="string"></option><option value="number" type="number"></option></type><prop name="value" type="input-value">Value.</prop>`;
      const outputs = generated(`<template component="x-dependent"><defs>
        <prop name="type" type="keyword" values="text, number" default="text">Mode.</prop>
        ${declaration}
      </defs><input from:type="$type" from:value="$value"></template>`);
      const vue = outputs.get("vue/XDependent.vue")!;
      const vanilla = outputs.get("vanilla/XDependent.d.ts")!;
      compileVue(vue, "XDependent.vue");
      assert.match(vue, /generic="T0 extends/);
      assert.match(vue, /T0 extends 'number' \? number/);
      assert.match(vanilla, /XDependentProps<T0 extends/);
      assert.match(vanilla, /T0 extends "number" \? number/);
      const directory = await mkdtemp(join(packageRoot, ".dependent-types-"));
      try {
        await writeFile(join(directory, "vanilla.d.ts"), vanilla);
        await writeFile(join(directory, "consumer.ts"), [
          'import { createXDependent } from "./vanilla";',
          'createXDependent({ type: "number", value: 2.5 });',
          'createXDependent({ type: "text", value: "2.5" });',
          'createXDependent({ value: "2.5" });',
          '// @ts-expect-error numeric mode requires a number',
          'createXDependent({ type: "number", value: "2.5" });',
          '// @ts-expect-error text mode requires a string',
          'createXDependent({ type: "text", value: 2.5 });',
          '// @ts-expect-error the default mode is text',
          'createXDependent({ value: 2.5 });',
          '',
        ].join("\n"));
        await run("corepack", [
          "pnpm", "exec", "tsc", "--ignoreConfig", "--noEmit", "--strict", "--exactOptionalPropertyTypes", "--skipLibCheck",
          "--target", "ES2023", "--module", "ESNext", "--moduleResolution", "Bundler", "--lib", "ES2023,DOM",
          join(directory, "consumer.ts"),
        ], { cwd: packageRoot, shell: process.platform === "win32" }).catch((error: { stdout?: string; stderr?: string }) => {
          throw new Error(`Dependent consumer typecheck failed.\n${error.stdout ?? ""}${error.stderr ?? ""}`, { cause: error });
        });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
  }

  it("generates a reactive state-selected prop for Vue and vanilla", () => {
    const outputs = generated(`<template component="x-state-dependent"><defs>
      <state name="mode" type="keyword" values="text, number" value="text"></state>
      <prop name="value">Value.<type from="mode"><option value="text" type="string"></option><option value="number" type="number"></option></type></prop>
      <handler name="toggle"><set name="mode" expr:value="$mode = 'text' ? 'number' : 'text'"></set></handler>
    </defs><button from:data-value="$value" on:click="toggle">Toggle</button></template>`);
    const vue = outputs.get("vue/XStateDependent.vue")!;
    const vanilla = outputs.get("vanilla/XStateDependent.d.ts")!;
    compileVue(vue, "XStateDependent.vue");
    assert.match(vue, /selectedPropNode\(mode\.value,/);
    assert.match(vue, /value: \{ type: null as unknown as PropType<(?:string \| number|number \| string) \| null>/);
    assert.match(vanilla, /value\?: (?:string \| number|number \| string) \| null/);
  });

  it("guards Vue handler writes by the selected destination type", () => {
    const vue = generated(`<template component="x-typed-handlers"><defs>
      <state name="count" type="number" value="2"></state>
      <state name="items" type="list(object({ name: string }))" value="[{ name: 'Ada' }]"></state>
      <state name="index" type="integer" value="0"></state>
      <handler name="badNumber"><set name="count" expr:value="concat($count)"></set></handler>
      <handler name="badField"><set name="items[$index].name" expr:value="7"></set></handler>
    </defs><main><button on:click="badNumber">Number</button><button on:click="badField">Field</button></main></template>`)
      .get("vue/XTypedHandlers.vue")!;
    compileVue(vue, "XTypedHandlers.vue");
    assert.match(vue, /if \(acceptsWrite\(next, isNumber, '<source>', 'badNumber', 'count'\)\) count\.value = next\n/);
    assert.match(vue, /if \(acceptsWrite\(next, isString, '<source>', 'badField', 'items\[\$index\]\.name'\)\)/);
  });

  it("uses a root $ref as the controller's root handle without duplicate Vue refs", () => {
    const vue = generated(`<template component="x-root-ref" controller="./root.js" status="early" summary="Root reference.">
      <button $ref="control" type="button">Go</button>
    </template>`).get("vue/XRootRef.vue")!;
    compileVue(vue, "XRootRef.vue");
    assert.match(vue, /const root = controlElement\b/);
    assert.match(vue, /<button[^>]*ref="controlElement"/);
    assert.doesNotMatch(vue, /ref="root"/);
  });

  it("types defaulted Vue props by their resolved values", async () => {
    const vue = generated(componentSource(
      "x-optional",
      `<prop name="label" type="string">Label.</prop><prop name="size" type="keyword" values="sm, md" default="md">Size.</prop>` +
        '<prop name="count" type="number" required>Count.</prop>',
      '<p from:data-label="$label" from:data-size="$size" from:data-count="$count"></p>',
    )).get("vue/XOptional.vue")!;
    // Vue applies defaults before exposing resolved props, including the implicit null default.
    assert.match(vue, /label: \{ type: null as unknown as PropType<string \| null>, default: null \}/);
    assert.match(vue, /size: \{ type: null as unknown as PropType<'sm' \| 'md' \| null>, default: 'md' \}/);
    assert.match(vue, /count: \{ type: null as unknown as PropType<number> \}/);

    // A consumer under exactOptionalPropertyTypes can omit an optional prop, but a resolved
    // instance prop does not include undefined after Vue applies its default.
    const directory = await mkdtemp(join(packageRoot, ".vue-types-"));
    try {
      await writeFile(join(directory, "XOptional.ts"), compileVue(vue, "XOptional.vue"));
      await writeFile(join(directory, "props.ts"), vuePropsArtifact().content);
      await writeFile(join(directory, "host.ts"), vueHostArtifact().content);
      await writeFile(join(directory, "consumer.ts"), [
        'import XOptional from "./XOptional";',
        'type Props = InstanceType<typeof XOptional>["$props"];',
        "export const unset: Props = { count: 1 };",
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

  it("types scalar concat output as text while preserving invalid-call results", async () => {
    const vue = generated(`<template component="x-concat-types">
      <defs><prop name="label" type="string">Label.</prop></defs>
      <div from:aria-label="concat($label, 1)">{$label}</div>
    </template>`).get("vue/XConcatTypes.vue")!;
    const checked = vue.replace("</script>", `
const scalar: string | undefined = concat('Label ', 1, true, null, undefined);
// @ts-expect-error an object can produce the invalid-result sentinel
const invalidObject: string | undefined = concat({ label: 'invalid' });
// @ts-expect-error a sentinel input is not a scalar
const invalidSymbol: string | undefined = concat(Symbol.for('html-next.invalid-result'));
// @ts-expect-error empty calls produce the invalid-result sentinel
const invalidEmpty: string | undefined = concat();
void [scalar, invalidObject, invalidSymbol, invalidEmpty];
</script>`);
    const directory = await mkdtemp(join(packageRoot, ".vue-concat-types-"));
    try {
      await writeFile(join(directory, "component.ts"), compileVue(checked, "XConcatTypes.vue"));
      await writeFile(join(directory, "props.ts"), vuePropsArtifact().content);
      await writeFile(join(directory, "host.ts"), vueHostArtifact().content);
      await run("corepack", [
        "pnpm", "exec", "tsc", "--ignoreConfig", "--noEmit", "--strict", "--skipLibCheck",
        "--target", "ES2023", "--module", "ESNext", "--moduleResolution", "Bundler", "--lib", "ES2023,DOM",
        join(directory, "component.ts"),
      ], { cwd: packageRoot, shell: process.platform === "win32" }).catch((error: { stdout?: string; stderr?: string }) => {
        throw new Error(`Concat consumer typecheck failed.\n${error.stdout ?? ""}${error.stderr ?? ""}`, { cause: error });
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps Vue's modelValue API while binding a native root through its DOM events", () => {
    const outputs = generated(componentSource(
      "x-field",
      '<prop name="value" type="string">Value.</prop>',
      '<input from:value="$value">',
    ));
    const vue = outputs.get("vue/XField.vue")!;
    compileVue(vue, "XField.vue");
    assert.match(vue, /modelValue: \{ type: null as unknown as PropType<string \| null \| undefined> \}/);
    assert.match(vue, /'update:modelValue': \[value: string\]\n/);
    // An unstyled root is the native control itself, marked by nothing but its own attributes.
    assert.match(vue, /<input\s+v-bind="nativeAttrs\(\$attrs\)"/);
    assert.match(vue, /v-bind-control="\{ tag: 'input', name: 'value', value: model, optionalValue: true, defaultValue: '' \}"/);
    assert.match(vue, /@input="model = readBoundControl\(/);
    assert.match(vue, /const model = computed\(\{\n  get: \(\) => checkedProps\.value\.modelValue \?\? checkedProps\.value\.value \?\? undefined,/);
    // The select uses the same native-control bridge; Vue's v-model would reassert stale state.
    const select = generated(componentSource("x-choice", '<prop name="value" type="string">Value.</prop>', '<select from:value="$value"><slot></slot></select>')).get("vue/XChoice.vue")!;
    assert.match(select, /<select\s+v-bind="nativeAttrs\(\$attrs\)"/);
    assert.match(select, /v-bind-control="\{ tag: 'select', name: 'value', value: model, optionalValue: true, defaultValue: '' \}"/);
    assert.match(select, /@change="model = readBoundControl\(/);
    assert.match(select, /<SelectedOptions\s+:value="model"\s+:multiple="false"\s+:native-property="false"/);
    assert.doesNotMatch(select, /v-model=/);
  });

  it("maps native property and attribute bindings to different Vue primitives", () => {
    const vue = generated(componentSource(
      "x-native-control-primitives",
      '<prop name="value" type="string">Value.</prop><prop name="selected" type="boolean">Selected.</prop>',
      '<div><input class="property" .value="$value" value="authored"><input class="attribute" from:value="$value"><input type="checkbox" from:checked="$selected"></div>',
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
      '<ul><slot $each="row of $rows" $key="$row.id" name="row" from:item="$row" from:index="$loop.index"><li $value="$row.name"></li></slot></ul></template>')
      .get("vue/XRowList.vue")!;
    compileVue(vue, "XRowList.vue");
    assert.match(vue, /v-for="[^"]*checkedProps\.rows/);
    assert.match(vue, /<slot :name="scopedSlotName\('row'\)" :item="row" :index="loop\.index">/);
    assert.match(vue, /<li>\s*\{\{ row\.name \}\}\s*<\/li>/);
  });

  it("converts a consumer's scoped-slot template with its lexical state", () => {
    const vue = generated(`<template component="x-consumer"><defs><state name="heading" type="string" value="People"></state></defs>` +
      `<section><x-row-list><template slot="row"><b $value="$item.name"></b><i $value="$heading"></i></template></x-row-list></section></template>`)
      .get("vue/XConsumer.vue")!;
    compileVue(vue, "XConsumer.vue");
    assert.match(vue, /<template #row="\{ item \}">/);
    assert.match(vue, /\{\{ text\(item\?\.name\) \}\}/);
    // A conforming state's own value needs no read check, so the consumer's text reads it directly.
    assert.match(vue, /<i>\{\{ heading \}\}<\/i>/);
  });

  it("keeps logical operators readable in Vue attribute values", () => {
    const vue = generated(componentSource(
      "x-both",
      '<prop name="a" type="boolean" default="false">A.</prop><prop name="b" type="boolean" default="false">B.</prop>',
      '<button from:hidden="$a and $b" from:title="$a" from:data-b="$b"></button>',
    )).get("vue/XBoth.vue")!;
    compileVue(vue, "XBoth.vue");
    assert.match(vue, /:hidden="checkedProps\.a && checkedProps\.b"/);
    assert.match(vue, /:title="checkedProps\.a \? '' : undefined"/);
  });

  it("serializes booleans on enumerated attributes as true and false", () => {
    const outputs = generated(componentSource(
      "x-aria",
      '<prop name="open" type="boolean" default="false">Open.</prop><prop name="gone" type="boolean" default="false">Gone.</prop>',
      '<button from:aria-expanded="$open" from:hidden="$gone"></button>',
    ));
    const vue = outputs.get("vue/XAria.vue")!;
    compileVue(vue, "XAria.vue");
    // Vue writes a boolean on an ARIA attribute as "true" or "false", and removes a false boolean attribute.
    assert.match(vue, /:aria-expanded="checkedProps\.open \?\? undefined"/);
    assert.match(vue, /:hidden="checkedProps\.gone \?\? undefined"/);
    // Vanilla writes them as the live runtime does (tests/vanilla-blocks.test.ts compares the DOM).
    assert.match(outputs.get("vanilla/XAria.js")!, /toAttribute\(x\d+, "aria-expanded"\)/);
  });

  it("parses generated Vanilla source", async () => {
    const generated = await targets();
    await transform(generated.get("vanilla/XButton.js")!, { loader: "js" });
  });

  it("converts to a Vue SFC that imports only Vue and the component's own modules", () => {
    const vue = generated(featureSource).get("vue/XFeature.vue")!;
    compileVue(vue, "XFeature.vue");
    assert.deepEqual(importsOf(vue).sort(), ["./XBadge.vue", "./control", "./host", "./props", "./props", "vue", "vue"]);
    assert.match(vue, /\(\) => import\('\.\/x-feature\.js'\)/);
    assert.doesNotMatch(vue, /@nextwebwg|attachComponent|manageGeneratedProps/);
  });

  it("maps each construct to Vue's own facility, as a Vue author writes it", () => {
    const vue = generated(featureSource).get("vue/XFeature.vue")!;
    assert.doesNotMatch(vue, /\bhn\b/);
    assert.match(vue, /const open = ref\(false\)\n/);
    assert.match(vue, /const query = ref\(''\)\n/);
    assert.match(vue, /const count = cycleCheckedComputed\(\(\) => checkedProps\.value\.items\?\.length\)\n/);
    assert.match(vue, /const searchElement = useTemplateRef<HTMLElement>\('searchElement'\)\n/);
    assert.match(vue, /const hostState = computed\(\(\) =>/);
    assert.match(vue, /checkedProps\.value\.size && 'size'/);
    assert.match(vue, /`size=\$\{encodeURIComponent\(checkedProps\.value\.size\)\}`/);
    assert.match(vue, /function flip\(\): void \{/);
    assert.match(vue, /const next = !open\.value\n/);
    assert.match(vue, /if \(acceptsWrite\(next, isBoolean, '<source>', 'flip', 'open'\)\) open\.value = next\n/);
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
    assert.match(vue, /:style="\{ '--gap': checkedProps\.size \?\? undefined \}"/);
    assert.match(vue, /<XBadge class="x-badge" :tone="checkedProps\.size"><slot name="badge">none<\/slot><\/XBadge>/);
    assert.match(vue, /<small v-if="checkedProps\.size === 'sm'">small<\/small>\n\s+<span v-else>regular<\/span>/);
    assert.doesNotMatch(vue, /defineExpose|installMethods/);
    assert.match(vue, /useComponentHost\(\(\) => import\('\.\/x-feature\.js'\), \{\n  root,\n  dispatch,/);
    assert.match(vue, /props: checkedProps,/);
  });

  it("reads a typed state list's items plainly while checking its keys", () => {
    const vue = generated(`<template component="x-tabs" status="experimental" summary="Typed state.">` +
      `<defs><state name="tabs" type="list(object({ id: string, label: string, active: boolean }))" value="[]"></state></defs>` +
      `<div><button $each="tab of $tabs" $key="$tab.id" from:id="$tab.id" from:aria-selected="$tab.active" class:active="$tab.active"><template $value="$tab.label"></template></button></div></template>`,
    ).get("vue/XTabs.vue")!;
    compileVue(vue, "XTabs.vue");
    assert.match(vue, /const tabs = ref<\{ id: string; label: string; active: boolean \}\[\]>\(\[\]\)\n/);
    assert.match(vue, /v-for="tab in uniqueKeys\(tabs, \(tab, index, loop\) => tab\.id\)"/);
    assert.match(vue, /:id="tab\.id"\n\s+:aria-selected="tab\.active"\n\s+:class="\{ active: tab\.active \}"\n\s+>\n?\s*\{\{ tab\.label \}\}/);
    assert.doesNotMatch(vue, /function (truthy|attribute)\(/);
  });

  it("types optional fields, open objects, and nullable records in state", () => {
    const vue = generated(`<template component="x-hover" status="experimental" summary="Typed records.">` +
      `<defs><state name="hovered" type="object({ row: integer, label?: string, ... })" ></state>` +
      `<state name="issues" type="list(object({ message: string }))" value="[]"></state></defs>` +
      `<div><span $if="$hovered" from:title="$hovered.label"></span><p $if="not $issues.length">Valid</p></div></template>`,
    ).get("vue/XHover.vue")!;
    compileVue(vue, "XHover.vue");
    assert.match(vue, /const hovered = ref<\{ row: number; label\?: string; \[name: string\]: any \} \| null>\(null\)\n/);
    assert.match(vue, /hovered\.value\?\.\['label'\] == null \|\| typeof hovered\.value\?\.\['label'\] === 'string'/);
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
      `<defs><state name="rows" type="list(" value="[]"></state></defs><div></div></template>`), /HC013/);
  });

  it("renders $value text, including a wrapper-less <template $value> slot fallback", () => {
    for (const controller of ["", ' controller="./x-row.js"']) {
      const vue = generated(
        `<template component="x-row" status="experimental" summary="A target compiler fixture."${controller}>` +
        `<defs><prop name="label" type="string" default="">Row label.</prop></defs>` +
        `<div><h2 $value="$label"></h2><span><slot name="label"><template $value="$label"></template></slot></span></div></template>`,
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
      `<select from:disabled="$disabled"><option value="">None</option><slot></slot></select></template>`,
    ).get("vue/XChoice.vue")!;
    compileVue(vue, "XChoice.vue");
    assert.match(vue, /<select[^>]*>\n\s+<option value="">None<\/option>\n\s+<slot \/>\n\s+<\/select>/);
  });

  it("types optional nullable props once", () => {
    const vue = generated(componentSource(
      "demo-anchor",
      `<prop name="anchor" type="keyword" values="start, end">Anchor edge.</prop>`,
      `<div from:data-edge="$anchor"></div>`,
    )).get("vue/DemoAnchor.vue")!;
    assert.match(vue, /anchor: \{ type: null as unknown as PropType<'start' \| 'end' \| null>, default: null \}/);
    assert.doesNotMatch(vue, /null \| null/);
  });

  it("renders a polymorphic root as the native root its `$match` arm chooses", async () => {
    const outputs = generated(`<template component="x-action" status="experimental" summary="Button or link.">
  <defs>
    <prop name="as" type="keyword" values="button, a" default="button">Native root.</prop>
    <prop name="href" type="string">Link.</prop>
    <prop name="disabled" type="boolean" default="false">Off.</prop>
    <prop name="tags" type="keyword#">Comma-separated tags.</prop>
    <prop name="spaceTags" type="keyword+">Space-separated tags.</prop>
  </defs>
  <template $match>
    <a $when="$as = 'a'" class="action" from:href="{ true: null, false: $href }[concat($disabled)]" from:data-tags="$tags" from:data-space-tags="$spaceTags" $ref="control"><slot></slot></a>
    <button $else class="action" type="button" from:disabled="$disabled" $ref="control"><slot></slot></button>
  </template>
  <style>:host { display: inline-flex; }</style>
</template>`);
    const vue = outputs.get("vue/XAction.vue")!;
    assert.match(vue, /as: \{ type: null as unknown as PropType<'button' \| 'a' \| null>, default: 'button' \}/);
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
    // The scoped styles select the root as `:host`, so each arm's root carries the tag as a class.
    assert.equal(await render({}), '<button class="x-action action" type="button">Go</button>');
    assert.equal(await render({ as: "a", href: "/next" }), '<a class="x-action action" href="/next" data-as="a" data-href="/next">Go</a>');
    const listed = await render({ as: "a", href: "/next", tags: ["red", "blue"], spaceTags: ["one", "two"] });
    assert.match(listed, /data-tags="red, blue"/);
    assert.match(listed, /data-space-tags="one two"/);
    // A null binding leaves the attribute off, so a disabled link has no href.
    assert.equal(await render({ as: "a", href: "/next", disabled: true }), '<a class="x-action action" data-as="a" data-disabled="true" data-href="/next">Go</a>');
    assert.match(await render({ constructor: "safe" }), / constructor="safe"/);

    const vanilla = outputs.get("vanilla/XAction.js")!;
    await transform(vanilla, { loader: "js", format: "esm" });
    // Compiled directly: the props choose the arm before the root exists, and a switch replaces it
    // (tests/vanilla-blocks.test.ts holds both to the live runtime).
    assert.doesNotMatch(vanilla, /html-next\/runtime/);
    assert.match(vanilla, /let a = \(.*\);\n  let element;\n  if \(a === 0\) \{\n    element = document\.createElement\("a"\);/);
    assert.match(vanilla, /\} else \{\n    element = document\.createElement\("button"\);/);
    assert.match(outputs.get("vanilla/XAction.d.ts")!, /interface XActionElement extends HTMLElement/);
    assert.match(outputs.get("docs/x-action.md")!, /Native element: `<a>` or `<button>`/);
  });

  it("converts a real-element root match and rejects a non-element root guard", () => {
    // A real-element $match keeps that element as the root and switches only its chosen child.
    const section = generateVueComponent(parseComponent(componentSource(
      "x-section",
      `<prop name="as" type="keyword" values="a, b" default="a">Kind.</prop>`,
      `<section $match from:data-as="$as"><p $when="$as = 'a'">A</p><p $else>B</p></section>`,
    )));
    assert.match(section, /<section[\s\S]*<p v-if="checkedProps\.as === 'a'">A<\/p>/);
    assert.throws(() => generateVueComponent(parseComponent(componentSource(
      "x-guarded",
      '<prop name="show" type="boolean" default="true">Show.</prop>',
      `<section $if="$show" from:data-show="$show">Visible</section>`,
    ))), /HT021/);
    // $html is supported through a generated, feature-specific sanitizer helper.
    const source = `<template component="demo-html" status="experimental" summary="Html.">
      <defs><state name="markup" type="string" value="<b>x</b>"></state></defs><div $html="$markup"></div></template>`;
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

  it("compiles two-way bindings through $each and $with aliases to their state paths in Vue, React and Svelte", async () => {
    const definition = parseComponent(`<template component="x-alias-writes" status="experimental" summary="Alias writes.">
      <defs><state name="draft" type="object({ owner: object({ name: string }) })" value="{ owner: { name: 'Ada' } }"></state>
      <state name="rows" type="list(object({ id: number, label: string }))" value="[]"></state></defs>
      <section><div $with="$draft.owner as owner"><input bind:value="owner.name"></div>
        <ul><li $each="row of $rows" $key="$row.id"><input bind:value="row.label"></li></ul></section>
    </template>`);
    const vue = generateVueComponent(definition);
    compileVue(vue, "XAliasWrites.vue");
    const react = generateReactComponent(definition);
    await transform(react, { loader: "tsx", format: "esm" });
    assert.match(vue, /draft\.owner\.name = readBoundControl\(/);
    assert.match(vue, /rows\[loop\.index\]\.label = readBoundControl\(/);
    assert.match(react, /\["owner", "name"\]/);
    assert.match(react, /\[loop\.index, "label"\]/);
    const svelte = Object.values(generateSvelteOutput(definition)).find((value): value is string => typeof value === "string" && value.includes("<script"))!;
    assert.match(svelte, /htmlNextWritePath\(draft, \["owner", "name"\]/);
    assert.match(svelte, /htmlNextWritePath\(rows, \[htmlNextRow0\.loop\.index, "label"\]/);
  });

  it("compiles numeric two-way controls directly through the shared control writer", () => {
    const module = generated(`<template component="demo-bound-number" status="experimental" summary="Numeric binding fallback.">
      <defs><state type="number" name="count" value="0"></state></defs>
      <section><input type="number" bind:value="count"><output $value="$count"></output></section>
    </template>`).get("vanilla/DemoBoundNumber.js")!;

    assert.doesNotMatch(module, /@nextwebwg\/html-next\/runtime/);
    assert.match(module, /writeControl\(/);
    assert.match(module, /bindControl\(I, /);
  });

  it("compiles radio two-way controls directly through the shared control writer", () => {
    const module = generated(`<template component="demo-bound-radio" status="experimental" summary="Radio binding fallback.">
      <defs><state type="boolean" name="selected" value="false"></state></defs>
      <section><input type="radio" bind:checked="selected"><output $value="$selected"></output></section>
    </template>`).get("vanilla/DemoBoundRadio.js")!;

    assert.doesNotMatch(module, /@nextwebwg\/html-next\/runtime/);
    assert.match(module, /writeControl\(/);
    assert.match(module, /bindControl\(I, /);
  });

  it("compiles multi-select bindings directly through the shared control writer", () => {
    const module = generated(`<template component="demo-bound-many" status="experimental" summary="Multi-select binding fallback.">
      <defs><state type="string" name="choice" value="one"></state></defs>
      <section><select multiple bind:value="choice"><option value="one">One</option><option value="two">Two</option></select><output $value="$choice"></output></section>
    </template>`).get("vanilla/DemoBoundMany.js")!;

    assert.doesNotMatch(module, /@nextwebwg\/html-next\/runtime/);
    assert.match(module, /writeControl\(/);
    assert.match(module, /bindControl\(I, /);
  });

  it("rejects deferred declarative connection handlers", () => {
    for (const binding of ["on:connect", "on:disconnect", "on:connect.once.exact.prevent.capture.enter.left", "on:disconnect.passive.stop"]) {
      assert.throws(() => generated(`<template component="demo-event-lifecycle" status="experimental" summary="Deferred lifecycle.">
        <defs><handler name="increment"></handler></defs>
        <button ${binding}="increment"></button>
      </template>`), /HT010/);
    }
  });

  it("exposes declared event detail through a typed Vue CustomEvent", () => {
    const vue = generated(`<template component="demo-vue-event" status="experimental" summary="Typed Vue event.">
      <defs>
        <event name="select" type="object"><prop name="value" type="keyword" values="small, large" required></prop></event>
        <handler name="choose"><dispatch event="select" expr:value="{ value: 'small' }"></dispatch></handler>
      </defs>
      <button on:click="choose">Choose</button>
    </template>`).get("vue/DemoVueEvent.vue")!;
    assert.match(vue, /select: \[event: CustomEvent<\{ readonly value: 'small' \| 'large' \}>\]/);
    assert.match(vue, /createDispatch\(root, emit as \(name: string, detail: unknown\) => void/);
  });

  it("compiles a type-incompatible primitive state directly with its declared-type check", () => {
    const module = generated(`<template component="demo-inert" status="experimental" summary="Typed direct primitive fallback.">
      <defs>
        <state name="open" type="string" value="false"></state>
        <handler name="toggle"><set name="open" expr:value="not $open"></set></handler>
      </defs>
      <button on:click="toggle" from:aria-expanded="$open"><output $value="$open"></output></button>
    </template>`).get("vanilla/DemoInert.js")!;

    assert.doesNotMatch(module, /@nextwebwg\/html-next\/runtime/);
    // The handler's write is checked against `string` and warns under its own key, as live does.
    assert.match(module, /setState\(I, p, x, "handler:toggle:open", "open"\)/);
  });

  it("subscribes Vue data reads only to from:value parameters", () => {
    const vue = generated(`<template component="x-param-modes"><defs>
      <state name="query" type="string" value="first"></state>
      <state name="token" type="string" value="a"></state>
      <data name="result" src="/api/search" type="string">
        <param name="q" from:value="$query"></param>
        <param name="token" expr:value="$token"></param>
      </data></defs><output $value="$result.value"></output></template>`).get("vue/XParamModes.vue")!;
    compileVue(vue, "XParamModes.vue");
    assert.match(vue, /sources: \(\) => \[query\.value\]/);
    assert.match(vue, /parameters: \(\) => \(\{ q: query\.value, token: token\.value \}\)/);
  });

  it("rejects a derived state initializer in favor of a computed declaration", () => {
    const source = `<template component="demo-initial-order" status="experimental" summary="State initialization order fallback.">
      <defs>
        <state type="number" name="count" value="0"></state>
        <computed name="derived" from="$count + 1"></computed>
        <state name="snapshot" from:value="$derived"></state>
        <handler name="increment"><set name="count" expr:value="$count + 1"></set></handler>
      </defs>
      <button on:click="increment"><output $value="$snapshot"></output></button>
    </template>`;

    assert.throws(() => generated(source), /uses a literal `value`/);
  });

  it("compiles string URL attributes directly through the sanitizing writer", () => {
    const module = generated(`<template component="demo-link" status="experimental" summary="String URL fallback.">
      <defs>
        <state type="string" name="destination" value="/start"></state>
        <handler name="change"><set name="destination" expr:value="'javascript:alert(1)'"></set></handler>
      </defs>
      <a on:click="change" from:href="$destination"><output $value="$destination"></output></a>
    </template>`).get("vanilla/DemoLink.js")!;

    assert.doesNotMatch(module, /@nextwebwg\/html-next\/runtime/);
    assert.match(module, /writeUrlAttribute\(r\.n, "href"/);
  });

  it("compiles bound SVG attributes directly with the parser's name adjustment", () => {
    const module = generated(`<template component="demo-svg-bound" status="experimental" summary="Bound SVG attribute.">
      <defs>
        <state type="number" name="size" value="24"></state>
        <handler name="grow"><set name="size" expr:value="$size + 1"></set></handler>
      </defs>
      <button on:click="grow"><svg from:viewBox="$size"><path d="M0 0"></path></svg></button>
    </template>`).get("vanilla/DemoSvgBound.js")!;

    assert.doesNotMatch(module, /@nextwebwg\/html-next\/runtime/);
    assert.match(module, /writeAttribute\([^,]+, "viewBox"/);
  });

  it("compiles multi-prop native property bindings directly", () => {
    const module = generated(componentSource(
      "demo-prop-values",
      `<prop name="value" type="number" default="1">Value.</prop><prop name="label" type="string" default="Ready">Label.</prop>`,
      `<section><input type="number" .value="$value" from:data-label="$label"></section>`,
    )).get("vanilla/DemoPropValues.js")!;

    assert.doesNotMatch(module, /@nextwebwg\/html-next\/runtime/);
  });

  it("compiles URL attribute sinks with their checks", () => {
    const module = generated(componentSource(
      "demo-link",
      `<prop name="target" type="string" default="https://example.test">Target.</prop>`,
      `<a from:href="$target"><slot></slot></a>`,
    )).get("vanilla/DemoLink.js")!;

    // tests/vanilla-blocks.test.ts holds the written URLs to the live runtime's.
    assert.doesNotMatch(module, /html-next\/runtime/);
    assert.match(module, /writeUrlAttribute\(/);
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
    // Vue's scoped styles select the root through its tag as a class, and a styled child component
    // through the same class on its invocation, which Vue passes to the child's root.
    assert.match(style, /\.x-feature \{\n  display: block;\n\}/);
    assert.match(style, /\.x-feature\[data-x-feature-state~="open"\] \.panel/);
    assert.match(style, /:slotted\(p\)/);
    assert.match(style, /:is\(x-badge, \.x-badge\)/);
    assert.match(vue, /<section\s+class="x-feature panel"/);
    assert.match(vue, /<XBadge class="x-badge" /);
    assert.doesNotMatch(vue, /data-component/);
    assert.match(vue, /:data-x-feature-state="hostState \|\| undefined"/);

    const vanilla = artifacts.get("vanilla/XFeature.js")!;
    assert.equal([...vanilla.matchAll(/setAttribute\("data-component"/g)].length, 1, "only the vanilla root is marked");
  });

  it("rejects :scope and undeclared or structured :host-state() names", () => {
    assert.throws(() => generated(componentSource("demo-a", "", `<div></div><style>:scope { color: red; }</style>`)), /HY003/);
    assert.throws(() => generated(componentSource("demo-b", "", `<div></div><style>:host-state([missing]) { color: red; }</style>`)), /HY001/);
    assert.throws(() => generated(componentSource("demo-c", "", `<defs><state name="items" type="list(string)" value="[]"></state></defs><div></div><style>:host-state([items]) { color: red; }</style>`)), /HY002/);
  });
});
