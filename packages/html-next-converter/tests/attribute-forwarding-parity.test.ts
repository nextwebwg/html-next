import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, it } from "vitest";

import { compileScript, compileTemplate, parse as parseVue } from "@vue/compiler-sfc";
import { build as esbuild } from "esbuild";
import { chromium, firefox, webkit, type BrowserType, type Page } from "playwright";

import { parseComponentResource } from "@nextwebwg/html-next";
import { renderComponents } from "@nextwebwg/html-next/server";
import { convertComponents } from "../src/index.js";
import { sveltePlugin } from "./helpers/svelte.js";
import { compiledFixtures } from "../../html-next/tests/hydration-fixtures.js";
import { launchParityBrowser } from "../../html-next/tests/pixel-parity.js";

const nativeStyleInput = { "--caller": "9px", width: 12, lineHeight: 1.5, aspectRatio: 2, fontSizeAdjust: 0.5 };
const dynamicSource = `<template component="x-native-style-leaf"><button $attributes>Native style</button></template>
<template component="x-native-style-wrapper"><x-native-style-leaf $attributes style:--local="'2px'"></x-native-style-leaf></template>
<template component="x-style-prop"><defs><prop name="style" type="string" default="color: green">Style text.</prop></defs><output>{$style}</output></template>
<template component="x-style-before"><defs><state name="local" type="string" value="--local: 2px"></state><handler name="change"><set name="local" value="--local: 4px"></set></handler></defs><button from:style="$local" $attributes style:--extra="'3px'" on:click="change">Before style</button></template>
<template component="x-style-after"><defs><state name="local" type="string" value="--local: 2px"></state><handler name="change"><set name="local" value="--local: 4px"></set></handler></defs><button $attributes from:style="$local" style:--extra="'3px'" on:click="change">After style</button></template>
<template component="x-class-before"><defs><state name="active" type="boolean" value="true"></state><handler name="toggle"><set name="active" expr:value="not $active"></set></handler></defs><button class:active="$active" $attributes on:click="toggle">Before class</button></template>
<template component="x-class-after"><defs><state name="active" type="boolean" value="true"></state><handler name="toggle"><set name="active" expr:value="not $active"></set></handler></defs><button $attributes class:active="$active" on:click="toggle">After class</button></template>
<template component="x-bound-before"><defs><state name="local" type="string" value="Local"></state><handler name="change"><set name="local" value="Changed"></set></handler></defs><button from:title="$local" $attributes on:click="change">Before binding</button></template>
<template component="x-bound-after"><defs><state name="local" type="string" value="Local"></state><handler name="change"><set name="local" value="Changed"></set></handler></defs><button $attributes from:title="$local" on:click="change">After binding</button></template>
<template component="x-before"><button $attributes title="Template">Before</button></template>
<template component="x-after"><button title="Template" $attributes>After</button></template>
<template component="x-inner"><section><button $attributes>Inner</button></section></template>
<template component="x-none"><button>None</button></template>
<template component="x-consumed"><defs><prop name="title" type="string">Title.</prop></defs><button $attributes>{$title}</button></template>
<template component="x-local-attribute"><defs><state name="rows" type="list(number)" value="[1]"></state><state name="divisor" type="number" value="1"></state><handler name="reject"><set name="divisor" value="0"></set></handler></defs><section><button id="reject-local" on:click="reject">Reject local</button><i $each="row of $rows" from:aria-selected="$row / $divisor = 1">Row</i></section></template>
<template component="x-selected-child"><defs><prop name="kind" type="keyword" values="text, number" default="number">Kind.</prop><prop name="value">Value.<type from="kind"><option value="text" type="string"></option><option value="number" type="number"></option></type></prop></defs><output>{$kind}:{$value}</output></template>
<template component="x-selected-wrap"><x-selected-child $attributes></x-selected-child></template>
<template component="x-selected-owner"><defs><state name="mode" type="string" value="text"></state><state name="entry" type="string" value="7"></state><handler name="reject"><set name="mode" value="bad space"></set><set name="entry" value="8"></set></handler></defs><section><x-selected-wrap from:kind="$mode" from:value="$entry"></x-selected-wrap><button id="reject-selector" on:click="reject">Reject selector</button></section></template>
<template component="x-page"><defs><state name="caller" type="string" from="'Caller'"></state><state name="callerStyle" type="string" from="'--caller: 9px; --local: 9px'"></state><state name="styleDivisor" type="number" value="1"></state><handler name="rejectStyle"><set name="styleDivisor" value="0"></set></handler><handler name="validStyle"><set name="styleDivisor" value="2"></set></handler><handler name="next"><set name="caller" value="Updated"></set><set name="callerStyle" value="--caller: 8px; --local: 8px"></set></handler><handler name="remove"><set name="caller" expr:value="null"></set><set name="callerStyle" expr:value="null"></set></handler></defs><main>
<div data-case="modified-style-prop"><x-style-prop from:style="$callerStyle" style:--local="concat(2 / $styleDivisor, 'px')"></x-style-prop></div><div data-case="declared-style"><x-style-prop from:style="$callerStyle"></x-style-prop></div><div data-case="style-before"><x-style-before from:style="$callerStyle"></x-style-before></div><div data-case="style-after"><x-style-after from:style="$callerStyle"></x-style-after></div>
<div data-case="before"><x-before from:title="$caller"></x-before></div>
<div data-case="after"><x-after from:title="$caller"></x-after></div>
<div data-case="inner"><x-inner from:title="$caller"></x-inner></div>
<div data-case="none"><x-none from:title="$caller"></x-none></div>
<div data-case="consumed"><x-consumed from:title="$caller"></x-consumed></div>
<div data-case="local-attribute"><x-local-attribute></x-local-attribute></div>
<div data-case="selected-attribute"><x-selected-owner></x-selected-owner></div>
<div data-case="class-before"><x-class-before from:class="$caller"></x-class-before></div><div data-case="class-after"><x-class-after from:class="$caller"></x-class-after></div>
<div data-case="bound-before"><x-bound-before from:title="$caller"></x-bound-before></div><div data-case="bound-after"><x-bound-after from:title="$caller"></x-bound-after></div>
<button id="reject-style-prop" on:click="rejectStyle">Reject style</button><button id="valid-style-prop" on:click="validStyle">Valid style</button><button id="next" on:click="next">Next</button><button id="remove" on:click="remove">Remove</button></main></template>`;
const nativeFixtures = JSON.parse(await readFile(new URL("../../html-next-dotnet/tests/fixtures/attribute-forwarding.json", import.meta.url), "utf8")) as readonly { name: string; source: string; expected: string }[];
const fixtures = [...nativeFixtures, ...[false, true].map(callerLast => ({
  name: `forwarded-keyed-style-${callerLast ? "caller" : "template"}-wins`,
  source: `<template component="x-subject"><button ${callerLast ? 'style:--local="\'2px\'" $attributes' : '$attributes style:--local="\'2px\'"'}>Styled</button></template><template component="x-page"><main><x-subject style="--caller: 0px; --local: 9px"></x-subject></main></template>`,
  expected: `<main><button style="--caller: 0px; --local: ${callerLast ? 9 : 2}px;">Styled</button></main>`,
})), ...[false, true].map(callerLast => ({
  name: `forwarded-bound-style-${callerLast ? "caller" : "template"}-wins`,
  source: `<template component="x-subject"><defs><prop name="local" type="string" default="--local: 2px">Local style.</prop></defs><button ${callerLast ? 'from:style="$local" $attributes' : '$attributes from:style="$local"'}>Styled</button></template><template component="x-page"><main><x-subject style="--caller: 0px; --local: 9px"></x-subject></main></template>`,
  expected: `<main><button style="${callerLast ? '--caller: 0px; --local: 9px;' : '--local: 2px;'}">Styled</button></main>`,
})), ...[false, true].map(callerLast => ({
  name: `forwarded-important-style-${callerLast ? "caller" : "template"}-wins`,
  source: `<template component="x-subject"><button ${callerLast ? 'style="color: red !important" $attributes' : '$attributes style="color: red !important"'}>Styled</button></template><template component="x-page"><main><x-subject style="color: blue"></x-subject></main></template>`,
  expected: `<main><button style="color: ${callerLast ? 'blue' : 'red !important'};">Styled</button></main>`,
})), ...[0, 1, 2].map(marker => {
  const operations = ['from:style="$local"', 'style:--extra="\'3px\'"'];
  operations.splice(marker, 0, '$attributes');
  return {
    name: `forwarded-whole-and-keyed-style-marker-${marker}`,
    source: `<template component="x-subject"><defs><prop name="local" type="string" default="--local: 2px">Local style.</prop></defs><button ${operations.join(' ')}>Styled</button></template><template component="x-page"><main><x-subject style="--caller: 9px; --local: 9px"></x-subject></main></template>`,
    expected: `<main><button style="${marker === 0 ? '--local: 2px;' : '--caller: 9px; --local: 9px;'}${marker === 2 ? '' : ' --extra: 3px;'}">Styled</button></main>`,
  };
}), {
  name: "declared-style-prop-is-text",
  source: `<template component="x-subject"><defs><prop name="style" type="string">Style text.</prop></defs><output $attributes>{$style}</output></template><template component="x-page"><main><x-subject style="color: blue" title="Caller"></x-subject></main></template>`,
  expected: '<main><output title="Caller">color: blue</output></main>',
}, {
  name: "forwarded-style-text-to-declared-prop",
  source: `<template component="x-child"><defs><prop name="style" type="string">Style text.</prop></defs><output $attributes>{$style}</output></template><template component="x-wrap"><x-child $attributes></x-child></template><template component="x-page"><main><x-wrap style="color: blue" title="Caller"></x-wrap></main></template>`,
  expected: '<main><output title="Caller">color: blue</output></main>',
}, {
  name: "declared-style-prop-null-restores-default",
  source: `<template component="x-subject"><defs><prop name="style" type="string" default="color: green">Style text.</prop></defs><output $attributes>{$style}</output></template><template component="x-page"><main><x-subject from:style="null"></x-subject></main></template>`,
  expected: '<main><output>color: green</output></main>',
}, {
  name: "invocation-style-modifier-updates-declared-prop",
  source: `<template component="x-subject"><defs><prop name="style" type="string">Style text.</prop></defs><output $attributes>{$style}</output></template><template component="x-page"><main><x-subject style="--caller: 0px" style:--local="'2px'"></x-subject></main></template>`,
  expected: '<main><output>--caller: 0px; --local: 2px;</output></main>',
}, {
  name: "forwarded-important-style-only",
  source: `<template component="x-subject"><button $attributes>Styled</button></template><template component="x-page"><main><x-subject style="color: red !important"></x-subject></main></template>`,
  expected: '<main><button style="color: red !important;">Styled</button></main>',
}, {
  name: "forwarded-list-prop",
  source: `<template component="x-child"><defs><prop name="items" type="list(integer)" default="[]">Items.</prop></defs><section><output>{$items.length}</output><b $each="item of $items">{$item}</b></section></template><template component="x-wrap"><x-child $attributes></x-child></template><template component="x-page"><main><x-wrap items="[1, 2]"></x-wrap></main></template>`,
  expected: '<main><section><output>2</output><b>1</b><b>2</b></section></main>',
}, {
  name: "forwarded-object-prop",
  source: `<template component="x-child"><defs><prop name="person" type="object({ name: string })" required>Person.</prop></defs><output>{$person.name}</output></template><template component="x-wrap"><x-child $attributes></x-child></template><template component="x-page"><main><x-wrap person="{ name: 'Ada' }"></x-wrap></main></template>`,
  expected: '<main><output>Ada</output></main>',
}, ...["number", "bad space"].map(kind => ({
  name: `forwarded-selected-prop-${kind === "number" ? "number" : "rejected-selector"}`,
  source: `<template component="x-child"><defs><prop name="kind" type="keyword" values="text, number" default="number">Kind.</prop><prop name="value">Value.<type from="kind"><option value="text" type="string"></option><option value="number" type="number"></option></type></prop></defs><output>{$value = 7}</output></template><template component="x-wrap"><x-child $attributes></x-child></template><template component="x-page"><main><x-wrap value="7" kind="${kind}"></x-wrap></main></template>`,
  expected: '<main><output>true</output></main>',
}))];
const unicodeFixture = fixtures.findIndex(fixture => fixture.name === "unicode-prop-exact-case");
assert.notEqual(unicodeFixture, -1);
const unicodeAttributes = { "é": "Attribute", [`data-x-case-${unicodeFixture}-subject-prop-É`]: "Prop" };

// React's Unicode attribute warning can report identical server/client values. Compare it with
// plain React, while the actual DOM, node identity and updates remain independently asserted.
function hydrationDiagnostics(messages: readonly string[]): unknown[] {
  return messages.map(message => ({
    message: message.split("\n")[0],
    attributes: message.split("\n").filter(line => /^[+-]\s+[^\s=]+=/u.test(line)).map(line => line.replace(/^([+-])\s+/, "$1 ")),
  }));
}
const staticSource = fixtures.map((fixture, index) => fixture.source.replace(/x-([a-z-]+)/g, `x-case-${index}-$1`)).join("");
const staticCalls = fixtures.map((fixture, index) => `<div data-fixture="${fixture.name}"><x-case-${index}-page></x-case-${index}-page></div>`).join("");
const source = staticSource + dynamicSource.replace('<button id="next"', staticCalls + '<button id="next"');
const files = { "page.html": source };
const enabled = process.env.HTMLNEXT_TARGET_TEST === "1";
const nodeModules = fileURLToPath(new URL("../node_modules", import.meta.url));
const htmlNextSource = fileURLToPath(new URL("../../html-next/src/", import.meta.url));
const modes = ["development", "production"] as const;
const vuePlugin = { name: "compiled-vue-sfc", setup(pluginBuild: { onResolve: (options: { filter: RegExp }, callback: (args: { path: string; resolveDir: string }) => { path: string }) => void }) {
  pluginBuild.onResolve({ filter: /\.vue$/ }, (args) => ({ path: resolve(args.resolveDir, args.path.replace(/\.vue$/, ".ts")) }));
} };
const build = (options: Parameters<typeof esbuild>[0], mode: (typeof modes)[number]) => esbuild({ ...options, bundle: true, format: "iife", platform: "browser", target: ["es2022"],
  minify: mode === "production", define: { "process.env.NODE_ENV": JSON.stringify(mode), __VUE_OPTIONS_API__: "true", __VUE_PROD_DEVTOOLS__: "false", __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: "false" }, loader: { ".css": "empty", ...options.loader } });

async function assertStaticCases(page: Page): Promise<void> {
  const renderedCases = await page.evaluate(fixtures => {
    const known = new Set(fixtures.flatMap((fixture, index) => [...fixture.source.matchAll(/component="(x-[a-z-]+)"/g)].map(match => match[1]!.replace("x-", `x-case-${index}-`))));
    const visible = (node: Node): unknown => {
      if (node.nodeType === 3) return node.textContent === "" ? undefined : node.textContent;
      if (!(node instanceof Element)) return undefined;
      const attributes = Array.from(node.attributes).filter(attribute => !known.has(attribute.name) && !["component", "data-component", "data-html-next-instance", "data-html-next-renderer", "data-valid", "data-slotted", "data-hn", "data-hn-owner", "ngh"].includes(attribute.name) && !/^(?:data-.*-prop-|data-.*-state$|_ng|ng-version)/.test(attribute.name)).map(attribute => [attribute.name, attribute.name === "style" ? (node as HTMLElement).style.cssText : attribute.value]).sort(([left], [right]) => left!.localeCompare(right!));
      return { tag: node.localName, attributes, children: Array.from(node.childNodes).map(visible).filter(node => node !== undefined) };
    };
    return fixtures.map(fixture => {
      const expected = document.createElement("template"); expected.innerHTML = fixture.expected;
      return { name: fixture.name, actual: visible(document.querySelector(`[data-fixture="${fixture.name}"] > main`)!), expected: visible(expected.content.firstChild!) };
    });
  }, fixtures);
  for (const fixture of renderedCases) assert.deepEqual(fixture.actual, fixture.expected, fixture.name);
}

for (const target of ["live", "vanilla", "vue", "react", "preact", "svelte", "angular"] as const) {
 describe.skipIf(!enabled)(`explicit attribute forwarding in ${target}`, () => {
  let directory = "";
  const bundles = new Map<string, string>();
  const servers = new Map<string, string>();
  const controls = new Map<string, string>();
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-attributes-"));
    await symlink(nodeModules, join(directory, "node_modules"), "dir");
    await writeFile(join(directory, "page.html"), source);
    const definitions = parseComponentResource(source, `file://${join(directory, "page.html")}`).definitions;
    if (target === "vanilla") await writeFile(join(directory, "vanilla.js"), await compiledFixtures("iife", 'const mount = document.querySelector("#mount"); const root = mount.firstElementChild; const next = createXPage({}, undefined, root ?? undefined); if (!root) mount.append(next);', definitions));
    const forms = new Map<string,string>();
    let nativeStyleComponent = "";
    if(target !== "live" && target !== "vanilla") {
      const out = join(directory, target);
      const manifest = await convertComponents({ mode: "application", target, root: directory, outDirectory: out, entries: ["page.html"], publicRootURL: "/" });
      forms.set(target, target === "angular" ? manifest.output.entry : manifest.components.find((component) => component.tag === "x-page")!.artifact);
      nativeStyleComponent = manifest.components.find(component => component.tag === "x-native-style-wrapper")!.artifact;
      if (target === "vue") {
        for (const component of manifest.components) {
          const path = join(out, component.artifact);
          const parsed = parseVue(await readFile(path, "utf8"), { filename: path });
          assert.deepEqual(parsed.errors, []);
          await writeFile(path.replace(/\.vue$/, ".ts"), compileScript(parsed.descriptor, { id: component.tag, inlineTemplate: true }).content);
          const script = compileScript(parsed.descriptor, { id: component.tag });
          const template = compileTemplate({ source: parsed.descriptor.template!.content, filename: path, id: component.tag, ssr: true, ssrCssVars: [], compilerOptions: { bindingMetadata: script.bindings ?? {} } });
          assert.deepEqual(template.errors, []);
          await writeFile(path.replace(/\.vue$/, ".ssr.ts"), `${script.content.replace("export default", "const Component =")}\n${template.code}\nexport default Object.assign(Component, { ssrRender });`);
        }
        await writeFile(join(out, "entry.ts"), `import { createApp, createSSRApp, h } from "vue"; import Form from "./${forms.get(target)}";
const mount = document.querySelector("#mount")!; (mount.hasChildNodes() ? createSSRApp : createApp)({ render: () => h(Form) }).mount(mount);\n`);
      } else if (target === "react") {
        await writeFile(join(out, "entry.tsx"), `import { createRoot, hydrateRoot } from "react-dom/client"; import Form from "./${forms.get(target)}"; import NativeStyle from "./${nativeStyleComponent}";
const content = <><Form /><div id="native-style-control"><NativeStyle style={${JSON.stringify(nativeStyleInput)}} /></div></>;
const mount = document.querySelector("#mount")!; if (mount.hasChildNodes()) hydrateRoot(mount, content); else createRoot(mount).render(content);
const reference = document.createElement("div"); reference.id = "native-style-reference"; document.body.append(reference);
createRoot(reference).render(<button style={${JSON.stringify(nativeStyleInput)}}>Reference</button>);\n`);
        await writeFile(join(out, "control.tsx"), `import { hydrateRoot } from "react-dom/client"; hydrateRoot(document.querySelector('#mount')!, <button {...${JSON.stringify(unicodeAttributes)}}>Prop</button>);`);
      } else if (target === "preact") {
        await writeFile(join(out, "entry.tsx"), `import { h, Fragment, render, hydrate } from "preact"; import Form from "./${forms.get(target)}"; import NativeStyle from "./${nativeStyleComponent}";
const content = h(Fragment, {}, [h(Form, {}), h('div', { id: 'native-style-control' }, h(NativeStyle, { style: ${JSON.stringify(nativeStyleInput)} }))]);
const mount = document.querySelector("#mount")!; (mount.hasChildNodes() ? hydrate : render)(content, mount);
const reference = document.createElement("div"); reference.id = "native-style-reference"; document.body.append(reference);
render(h('button', { style: ${JSON.stringify(nativeStyleInput)} }, 'Reference'), reference);\n`);
      } else if (target === "angular") {
        const app = join(out, "app.ts");
        await writeFile(app, `import { Component } from "@angular/core"; import { XPage } from "./${forms.get(target)!.replace(/\.ts$/, "")}";
@Component({ selector: "app-root", standalone: true, imports: [XPage], template: '<main x-page></main>' }) export class App {}`);
        const config = join(out, "tsconfig.json");
        await writeFile(config, JSON.stringify({ compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", strict: true, skipLibCheck: true,
          experimentalDecorators: true, rewriteRelativeImportExtensions: true, rootDir: out, outDir: join(out, "compiled"), types: [] }, angularCompilerOptions: { strictTemplates: true }, files: [app] }));
        const require = createRequire(import.meta.url);
        const ngc = join(dirname(require.resolve("@angular/compiler-cli/package.json")), "bundles/src/bin/ngc.js");
        try { await promisify(execFile)(process.execPath, [ngc, "-p", config], { cwd: out }); }
        catch (error) { assert.fail((error as { stderr?: string }).stderr ?? String(error)); }
        await writeFile(join(out, "entry.ts"), `import "@angular/compiler"; import { bootstrapApplication, provideClientHydration } from "@angular/platform-browser"; import { App } from "./compiled/app.js";
const mount = document.querySelector("#mount")!; const hydrate = mount.hasChildNodes(); if (!hydrate) mount.append(document.createElement("app-root")); bootstrapApplication(App, { providers: hydrate ? [provideClientHydration()] : [] });\n`);
      } else {
        await writeFile(join(out, "entry.ts"), `import { mount, hydrate } from "svelte"; import { createAttachmentKey } from "svelte/attachments"; import Form from "./${forms.get(target)}";
const target = document.querySelector("#mount")!; const props = { [createAttachmentKey()]: (element: Element) => { (window as any).attributeRoot = element; } }; if (target.hasChildNodes()) hydrate(Form, { target, props, recover: false }); else mount(Form, { target, props });\n`);
      }
    }
    for (const mode of modes) {
      const bundle = (target: string) => join(directory, `${target}-${mode}.js`);
      if(target === "live") await build({ entryPoints: [join(htmlNextSource, "browser-loader.ts")], outfile: bundle("live"), globalName: "HtmlNextLoader" }, mode);
      if(target === "vanilla") await writeFile(bundle("vanilla"), await readFile(join(directory, "vanilla.js"), "utf8"));
      if(target === "vue") await build({ entryPoints: [join(directory, "vue", "entry.ts")], outfile: bundle("vue"), nodePaths: [nodeModules], plugins: [vuePlugin] }, mode);
      if(target === "react") await build({ entryPoints: [join(directory, "react", "entry.tsx")], outfile: bundle("react"), jsx: "automatic", nodePaths: [nodeModules] }, mode);
      if(target === "react") await build({ entryPoints: [join(directory, "react", "control.tsx")], outfile: bundle("control"), jsx: "automatic", nodePaths: [nodeModules] }, mode);
      if(target === "preact") await build({ entryPoints: [join(directory, "preact", "entry.tsx")], outfile: bundle("preact"), jsx: "automatic", jsxImportSource: "preact", nodePaths: [nodeModules] }, mode);
      if(target === "angular") await build({ entryPoints: [join(directory, "angular", "entry.ts")], outfile: bundle("angular"), nodePaths: [nodeModules] }, mode);
      if(target === "svelte") await build({ entryPoints: [join(directory, "svelte", "entry.ts")], outfile: bundle("svelte"), plugins: [sveltePlugin("client")] }, mode);
      bundles.set(mode, bundle(target));
      if (target === "live" || target === "vanilla") servers.set(mode, (await renderComponents("<x-page></x-page>", { definitions })).html);
      else {
        const out = join(directory, target), serverEntry = join(out, "server.tsx"), serverBundle = join(out, `server-${mode}.mjs`);
        const component = forms.get(target)!;
        await writeFile(serverEntry, target === "vue" ? `import { createSSRApp, h } from "vue"; import { renderToString } from ${JSON.stringify(pathToFileURL(createRequire(new URL("../../html-next/package.json", import.meta.url)).resolve("@vue/server-renderer")).href)}; import Form from "./${component}"; export const html = await renderToString(createSSRApp({ render: () => h(Form) }));`
          : target === "svelte" ? `import { render } from "svelte/server"; import Form from "./${component}"; export const html = render(Form).body;`
          : target === "angular" ? `import "@angular/compiler"; import { renderApplication, provideServerRendering } from "@angular/platform-server"; import { bootstrapApplication, provideClientHydration } from "@angular/platform-browser"; import { App } from "./compiled/app.js"; export const html = await renderApplication(context => bootstrapApplication(App, { providers: [provideServerRendering(), provideClientHydration()] }, context), { document: '<html><head><base href="https://app.example/"></head><body><div id="mount"><app-root></app-root></div></body></html>', url: 'https://app.example/', allowedHosts: ['app.example'] });`
          : `import { renderToString } from "${target === "preact" ? "preact-render-to-string" : "react-dom/server"}"; import Form from "./${component}"; import NativeStyle from "./${nativeStyleComponent}"; export const html = renderToString(<><Form /><div id="native-style-control"><NativeStyle style={${JSON.stringify(nativeStyleInput)}} /></div></>);`);
        if (target === "react") await writeFile(serverEntry, (await readFile(serverEntry, "utf8")) + `\nexport const controlHtml = renderToString(<button {...${JSON.stringify(unicodeAttributes)}}>Prop</button>);`);
        await esbuild({ entryPoints: [serverEntry], outfile: serverBundle, bundle: true, format: "esm", platform: "node", packages: "external", jsx: "automatic", jsxImportSource: target === "preact" ? "preact" : "react", define: { "process.env.NODE_ENV": JSON.stringify(mode), __VUE_OPTIONS_API__: "true", __VUE_PROD_DEVTOOLS__: "false", __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: "false" }, loader: { ".css": "empty" }, plugins: target === "vue" ? [{ name: "vue-server", setup(builder) { builder.onResolve({ filter: /\.vue$/ }, args => ({ path: resolve(args.resolveDir, args.path.replace(/\.vue$/, ".ssr.ts")) })); } }] : target === "svelte" ? [sveltePlugin("server")] : [] });
        const output = join(out, `server-${mode}.html`);
        const controlOutput = join(out, `control-${mode}.html`);
        await promisify(execFile)(process.execPath, ["--input-type=module", "-e", `const module = await import(${JSON.stringify(pathToFileURL(serverBundle).href)}); const fs = await import('node:fs/promises'); await fs.writeFile(${JSON.stringify(output)}, module.html); if (module.controlHtml !== undefined) await fs.writeFile(${JSON.stringify(controlOutput)}, module.controlHtml);`], { cwd: out, env: { ...process.env, NODE_ENV: mode } });
        servers.set(mode, await readFile(output, "utf8"));
        if (target === "react") controls.set(mode, await readFile(controlOutput, "utf8"));
      }
    }
  }, 240_000);
  afterAll(async () => { if (directory !== "") await rm(directory, { recursive: true, force: true }); });

  for (const [engine, browserType] of [["Chromium", chromium], ["Firefox", firefox], ["WebKit", webkit]] as const satisfies ReadonlyArray<readonly [string, BrowserType]>) {
    for (const mode of modes) for (const hydrated of [false, true]) {
      it(`${engine} ${mode} ${hydrated ? "hydrated" : "fresh"} preserves explicit destinations, prop consumption and authored precedence`, async () => {
        const browser = await launchParityBrowser(browserType);
        const errors: string[] = [];
        try {
          let expectedDiagnostics: unknown[] = [];
          if (target === "react" && hydrated && mode === "development") {
            const control = await browser.newPage();
            const warnings: string[] = [];
            const controlErrors: string[] = [];
            control.on("console", message => { if (["error", "warning"].includes(message.type()) && /hydrat|mismatch|NG05/i.test(message.text())) warnings.push(message.text()); });
            control.on("pageerror", error => controlErrors.push(error.message));
            await control.setContent('<meta charset="utf-8"><div id="mount">' + controls.get(mode)! + '</div>');
            const before = await control.locator("button").evaluate(element => element.outerHTML);
            await control.addScriptTag({ path: join(directory, `control-${mode}.js`) });
            await control.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
            assert.equal(await control.locator("button").evaluate(element => element.outerHTML), before);
            assert.deepEqual(controlErrors, []);
            expectedDiagnostics = hydrationDiagnostics(warnings);
            await control.close();
          }
          const page = await browser.newPage();
          page.on("pageerror", error => errors.push(error.message));
          await page.route("https://app.example/**", route => {
            const name = new URL(route.request().url()).pathname.slice(1);
            const body = name === "page.html" ? files[name] : hydrated && target === "angular" ? servers.get(mode)!
              : `${target === "live" ? '<link rel="component" href="/page.html">' : ''}<div id="mount">${hydrated ? servers.get(mode)! : target === "live" ? '<x-page></x-page>' : ''}</div>`;
            return route.fulfill({ contentType: "text/html; charset=utf-8", body: name === "page.html" ? body : '<!doctype html><meta charset="utf-8">' + body });
          });
          await page.goto("https://app.example/");
          if (hydrated) {
            await assertStaticCases(page);
            await page.evaluate(() => { (window as any).attributeNodes = Array.from(document.querySelectorAll('[data-case] button')); });
          }
          page.on("console", message => { if (["error", "warning"].includes(message.type()) && /hydrat|mismatch|NG05/i.test(message.text())) errors.push(message.text()); });
          await page.addScriptTag({ path: bundles.get(mode)! });
          if(target === "live") await page.evaluate(() => (window as unknown as { HtmlNextLoader: { startBrowserComponents(): Promise<unknown> } }).HtmlNextLoader.startBrowserComponents());
          await page.waitForSelector('[data-case="after"] button', { state: "attached" });
          const snapshot = () => page.evaluate(() => {
            const get = (name: string, selector: string) => document.querySelector(`[data-case="${name}"] ${selector}`);
            return { before: get("before", "button")?.getAttribute("title"), after: get("after", "button")?.getAttribute("title"), innerRoot: get("inner", "section")?.getAttribute("title"), inner: get("inner", "button")?.getAttribute("title"), none: get("none", "button")?.getAttribute("title"), consumedTitle: get("consumed", "button")?.getAttribute("title"), consumedText: get("consumed", "button")?.textContent };
          });
          await assertStaticCases(page);
          if (target === "react" || target === "preact") {
            await page.waitForSelector('#native-style-reference button');
            const styles = await page.evaluate(() => ['native-style-control', 'native-style-reference'].map(id => {
              const style = document.querySelector<HTMLElement>(`#${id} button`)!.style;
              return [style.getPropertyValue('--caller').trim(), style.width, style.lineHeight, style.aspectRatio, style.fontSizeAdjust];
            }));
            assert.deepEqual(styles[0], styles[1], "forwarding and modifiers preserve the framework's native style input semantics");
            assert.deepEqual(styles[0]!.slice(0, 4), ['9px', '12px', '1.5', '2 / 1']);
            assert.equal(await page.locator('#native-style-control button').evaluate((element: HTMLElement) => element.style.getPropertyValue('--local').trim()), '2px');
          }
          const expected = (caller: string) => ({ before: "Template", after: caller, innerRoot: null, inner: caller, none: null, consumedTitle: null, consumedText: caller });
          const settle = () => page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
          await settle(); assert.deepEqual(hydrationDiagnostics(errors), expectedDiagnostics); assert.deepEqual(await snapshot(), expected("Caller"));
          if (target === "svelte") assert.equal(await page.evaluate(() => (window as any).attributeRoot === document.querySelector('#mount > main')), true);
          assert.equal(await page.locator('[data-case="local-attribute"] i').getAttribute('aria-selected'), 'true');
          assert.equal(await page.locator('[data-case="selected-attribute"] output').textContent(), 'text:7');
          await page.click('#reject-selector'); await settle();
          assert.equal(await page.locator('[data-case="selected-attribute"] output').textContent(), 'text:8');
          await page.click('#reject-local'); await settle();
          assert.equal(await page.locator('[data-case="local-attribute"] i').getAttribute('aria-selected'), 'true');
          if (hydrated) assert.equal(await page.evaluate(() => (window as any).attributeNodes.every((node: Node, index: number) => node === document.querySelectorAll('[data-case] button')[index])), true, "hydration keeps the server nodes");
          const modifiedStyle = () => page.evaluate(() => {
            const style = document.createElement("span").style;
            style.cssText = document.querySelector('[data-case="modified-style-prop"] output')!.textContent!;
            return [style.getPropertyValue("--caller").trim(), style.getPropertyValue("--local").trim()];
          });
          assert.deepEqual(await modifiedStyle(), ["9px", "2px"]);
          await page.click("#reject-style-prop"); await settle();
          assert.deepEqual(await modifiedStyle(), ["9px", "2px"]);
          const declaredStyle = () => page.locator('[data-case="declared-style"] output').textContent();
          assert.equal(await declaredStyle(), "--caller: 9px; --local: 9px");
          const styles = () => page.evaluate(() => ["style-before", "style-after"].map(name => {
            const style = document.querySelector<HTMLElement>(`[data-case="${name}"] button`)!.style;
            return [style.getPropertyValue("--caller").trim(), style.getPropertyValue("--local").trim(), style.getPropertyValue("--extra").trim()];
          }));
          assert.deepEqual(await styles(), [["9px", "9px", "3px"], ["", "2px", "3px"]]);
          for (const name of ["style-before", "style-after"]) await page.click(`[data-case="${name}"] button`);
          await settle(); assert.deepEqual(await styles(), [["9px", "9px", "3px"], ["", "4px", "3px"]]);
          const classes = () => page.evaluate(() => ["class-before", "class-after"].map(name => document.querySelector(`[data-case="${name}"] button`)?.getAttribute("class")));
          const bound = () => page.evaluate(() => ["bound-before", "bound-after"].map(name => document.querySelector(`[data-case="${name}"] button`)?.getAttribute("title")));
          assert.deepEqual(await classes(), ["Caller", "Caller active"]);
          assert.deepEqual(await bound(), ["Caller", "Local"]);
          for (const name of ["bound-before", "bound-after"]) await page.click(`[data-case="${name}"] button`);
          await settle(); assert.deepEqual(await bound(), ["Caller", "Changed"]);
          await page.click("#next"); await settle(); assert.deepEqual(await snapshot(), expected("Updated"));
          assert.deepEqual(await modifiedStyle(), ["8px", "2px"]);
          assert.equal(await declaredStyle(), "--caller: 8px; --local: 8px");
          assert.deepEqual(await styles(), [["8px", "8px", "3px"], ["", "4px", "3px"]]);
          assert.deepEqual(await classes(), ["Updated", "Updated active"]);
          assert.deepEqual(await bound(), ["Updated", "Changed"]);
          for (const name of ["class-before", "class-after"]) await page.click(`[data-case="${name}"] button`);
          await settle(); assert.deepEqual(await classes(), ["Updated", "Updated"]);
          for (const name of ["class-before", "class-after"]) await page.click(`[data-case="${name}"] button`);
          await settle(); assert.deepEqual(await classes(), ["Updated", "Updated active"]);
          await page.click("#remove"); await settle(); assert.deepEqual(await classes(), ["active", "active"]);
          assert.deepEqual(await modifiedStyle(), ["", "2px"]);
          await page.click("#valid-style-prop"); await settle();
          assert.deepEqual(await modifiedStyle(), ["", "1px"]);
          assert.equal(await declaredStyle(), "color: green");
          assert.deepEqual(await styles(), [["", "4px", "3px"], ["", "4px", "3px"]]);
          assert.deepEqual(await bound(), ["Changed", "Changed"]);
          assert.equal(await page.locator('[data-case="after"] button').getAttribute("title"), "Template");
          assert.deepEqual(hydrationDiagnostics(errors), expectedDiagnostics);
        } finally { await browser.close(); }
      });
    }
  }
 });
}
