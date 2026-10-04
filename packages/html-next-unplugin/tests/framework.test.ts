import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, it } from "vitest";
import { build, createServer, normalizePath } from "vite";
import vue from "@vitejs/plugin-vue";
import { h } from "vue";
import { renderToString } from "vue/server-renderer";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { chromium } from "playwright";
import react from "@vitejs/plugin-react";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import htmlNext from "../src/vite.js";
import { syncHtmlNext } from "../src/framework.js";
import { installSourcePackage } from "./source-package.js";

const run = promisify(execFile);
const require = createRequire(import.meta.url);
const temporary: string[] = [];
const modules = fileURLToPath(new URL("../node_modules", import.meta.url));
afterEach(async () => {
  for (const root of temporary.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "html-next-framework-"));
  temporary.push(root);
  const library = join(root, "node_modules", "@example", "controls");
  await mkdir(library, { recursive: true });
  await mkdir(join(root, "src"));
  await mkdir(join(root, "node_modules", "@types"));
  for (const name of ["vue", "react", "react-dom", "svelte", "@types/react", "@types/react-dom"]) {
    await symlink(join(modules, name), join(root, "node_modules", name), "dir");
  }
  await writeFile(join(root, "package.json"), JSON.stringify({ type: "module", dependencies: { "@example/controls": "1.0.0" } }));
  await writeFile(join(library, "package.json"), JSON.stringify({ name: "@example/controls", type: "module", exports: {
    ".": { "html-next": "./index.js" }, "./direct": { "html-next": "./controls.html" },
  } }));
  await writeFile(join(library, "index.js"), 'export { UiButton as Button, UiBadge, UiUnused } from "./controls.html";\n');
  await writeFile(join(library, "controls.html"), `<template component="ui-button" status="early" summary="Button.">
  <defs>
    <prop name="label" type="string" required>Label.</prop>
    <prop name="size" type="keyword" values="small, large" default="small">Size.</prop>
    <state name="count" type="integer" value="0"></state>
    <handler name="increment"><set name="count" expr:value="$count + 1"></set></handler>
  </defs>
  <button on:click="increment"><span $value="$label"></span><output $value="$count"></output><ui-badge></ui-badge><slot></slot></button>
  <style>:host { color: rgb(1, 2, 3); }</style>
</template>
<template component="ui-badge" status="early" summary="Badge."><span>Badge</span></template>
<template component="ui-unused" status="early" summary="Unused."><aside>UNUSED_COMPONENT_MARKER</aside>
  <style>:host { --unused-component-style: keep-out; }</style></template>`);
  return { root, library };
}

for (const target of ["vue", "react"] as const) describe(`${target} source adapter`, () => {
  it("consumes a packed component folder without an authored index or build script", async () => {
    const { root, library } = await fixture();
    const controls = await readFile(join(library, "controls.html"), "utf8");
    await installSourcePackage(root, {
      "components/controls.html": controls,
      "components/nested/card.html": '<template component="ui-card" controller="./card.js" status="early" summary="Card."><section>Nested card</section></template>',
      "components/nested/card.js": 'export default host => host.root.setAttribute("data-ready", "yes");',
    });
    const filename = target === "vue" ? "folder.ts" : "folder.tsx";
    await writeFile(join(root, "src", filename), target === "vue"
      ? `import { h } from "vue"; import { renderToString } from "vue/server-renderer";
        import { UiButton } from "@example/controls"; import { UiCard } from "@example/controls/nested";
        export const render = () => renderToString(h("main", [h(UiButton, { label: "Save" }), h(UiCard)]));`
      : `import React from "react"; import { renderToStaticMarkup } from "react-dom/server";
        import { UiButton } from "@example/controls"; import { UiCard } from "@example/controls/nested";
        export const render = () => renderToStaticMarkup(<main><UiButton label="Save" /><UiCard /></main>);`);
    await build({ root, configFile: false, logLevel: "silent", plugins: [htmlNext({ target }), target === "vue" ? vue() : react()],
      build: { ssr: join(root, "src", filename), outDir: "dist", minify: false } });
    const output = await import(pathToFileURL(join(root, "dist", "folder.js")).href) as { render(): string | Promise<string> };
    assert.match(await output.render(), /Save.*Badge.*Nested card/s);
    const bundle = await readFile(join(root, "dist", "folder.js"), "utf8");
    assert.doesNotMatch(bundle, /UNUSED_COMPONENT_MARKER|parseComponent|parse5/);
    const prepared = await syncHtmlNext({ root, target });
    const declarations = await readFile(prepared.declarationsFile, "utf8");
    assert.match(declarations, /export const UiButton:/);
    assert.match(declarations, /declare module "@example\/controls\/nested"/);
    assert.ok(prepared.sourceFiles.includes(await realpath(join(library, "components", "nested", "card.html"))));
    const client = target === "vue" ? "client.ts" : "client.tsx";
    await writeFile(join(root, "src", client), target === "vue"
      ? `import { createApp, h } from "vue"; import { UiButton } from "@example/controls";
        createApp({ render: () => h(UiButton, { label: "Save" }) }).mount("#app");`
      : `import React from "react"; import { createRoot } from "react-dom/client"; import { UiButton } from "@example/controls";
        createRoot(document.getElementById("app")!).render(<UiButton label="Save" />);`);
    await writeFile(join(root, "index.html"), `<div id="app"></div><script type="module" src="/src/${client}"></script>`);
    await build({ root, configFile: false, logLevel: "silent", plugins: [htmlNext({ target }), target === "vue" ? vue() : react()],
      build: { outDir: "client-dist" } });
    assert.match(await readFile(join(root, "client-dist", "index.html"), "utf8"), /assets\//);

  }, 60_000);

  it("converts a source-only package, preserves aliases, and generates precise consumer declarations", async () => {
    const { root } = await fixture();
    const entry = target === "vue"
      ? `import { h } from "vue"; import { renderToString } from "vue/server-renderer"; import { Button } from "@example/controls"; export const render = () => renderToString(h(Button, { label: "Save", size: "large" }));`
      : `import React from "react"; import { renderToStaticMarkup } from "react-dom/server"; import { Button } from "@example/controls"; export const render = () => renderToStaticMarkup(<Button label="Save" size="large" />);`;
    const filename = target === "vue" ? "entry.ts" : "entry.tsx";
    await writeFile(join(root, "src", filename), entry);
    await build({ root, configFile: false, logLevel: "silent", plugins: [htmlNext({ target }), target === "vue" ? vue() : react()],
      build: { ssr: join(root, "src", filename), outDir: "dist", minify: false } });
    const output = await import(pathToFileURL(join(root, "dist", "entry.js")).href) as { render(): string | Promise<string> };
    const rendered = await output.render();
    assert.match(rendered, /Save/);
    assert.match(rendered, /Badge/);
    assert.doesNotMatch(rendered, /<ui-button|<ui-badge/);
    const declarations = await readFile(join(root, "src", "html-next.d.ts"), "utf8");
    assert.match(declarations, /declare module "@example\/controls"/);
    assert.match(declarations, /export const Button:/);
    assert.match(declarations, /export const UiButton:/);
    assert.doesNotMatch(await readFile(join(root, "dist", "entry.js"), "utf8"), /parseComponent|parse5|html-next\/live|UNUSED_COMPONENT_MARKER/);
    await writeFile(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: {
      strict: true, skipLibCheck: true, module: "ESNext", moduleResolution: "Bundler", target: "ES2022", jsx: "react-jsx", noEmit: true,
    }, include: ["src"] }));
    await writeFile(join(root, "src", target === "vue" ? "consumer.vue" : "consumer.tsx"), target === "vue"
      ? `<script setup lang="ts">import { Button } from '@example/controls';</script><template><Button label="Save" size="large" /></template>`
      : `import { Button } from '@example/controls'; export const good = <Button label="Save" size="large" />;`);
    const compiler = require.resolve(target === "vue" ? "vue-tsc/bin/vue-tsc.js" : "typescript/bin/tsc");
    await run(process.execPath, [compiler, "--noEmit", "-p", join(root, "tsconfig.json")], { cwd: root });
    await writeFile(join(root, "src", target === "vue" ? "invalid.vue" : "invalid.tsx"), target === "vue"
      ? `<script setup lang="ts">import { Button } from '@example/controls';</script><template><Button :label="42" size="huge" /></template>`
      : `import { Button } from '@example/controls'; export const bad = <Button label={42} size="huge" />;`);
    await assert.rejects(run(process.execPath, [compiler, "--noEmit", "-p", join(root, "tsconfig.json")], { cwd: root }), (error: unknown) => {
      const result = error as { stdout: string };
      assert.match(result.stdout, /number.*string/);
      assert.match(result.stdout, /huge/);
      return true;
    });
  }, 60_000);

  it("omits unused component markup and CSS from a client build", async () => {
    const { root } = await fixture();
    const entry = join(root, "src", target === "vue" ? "client.ts" : "client.tsx");
    await writeFile(entry, target === "vue"
      ? `import { createApp, h } from "vue"; import { Button } from "@example/controls";
        createApp({ render: () => h(Button, { label: "Save" }) }).mount("#app");`
      : `import React from "react"; import { createRoot } from "react-dom/client";
        import { Button } from "@example/controls";
        createRoot(document.getElementById("app")!).render(<Button label="Save" />);`);
    const result = await build({ root, configFile: false, logLevel: "silent",
      plugins: [htmlNext({ target }), target === "vue" ? vue() : react()],
      build: { rollupOptions: { input: entry }, write: false, minify: false } });
    const bundles = Array.isArray(result) ? result : [result];
    const output = bundles.flatMap((bundle) => "output" in bundle ? bundle.output : []);
    const content = output.map((item) => item.type === "asset" ? String(item.source) : item.code).join("\n");
    assert.match(content, /rgb\(1, ?2, ?3\)/);
    assert.equal(content.includes("UNUSED_COMPONENT_MARKER"), false, "unused component markup entered the client bundle");
    assert.equal(content.includes("--unused-component-style"), false, "unused component CSS entered the client bundle");
  }, 60_000);

  it("resolves TypeScript ESM specifiers and TSX hops in a source barrel", async () => {
    const { root, library } = await fixture();
    const packagePath = join(library, "package.json");
    const manifest = JSON.parse(await readFile(packagePath, "utf8")) as { exports: Record<string, { "html-next": string }> };
    manifest.exports["."] = { "html-next": "./index.ts" };
    await writeFile(packagePath, JSON.stringify(manifest));
    await writeFile(join(library, "index.ts"), 'export { Button } from "./bridge.js";\n');
    await writeFile(join(library, "bridge.tsx"), 'export { UiButton as Button } from "./controls.html";\n');
    const prepared = await syncHtmlNext({ root, target });
    assert.ok(prepared.aliases.has("@example/controls"));
    assert.match(await readFile(prepared.declarationsFile, "utf8"), /export const Button:/);
    const entry = join(root, "src", target === "vue" ? "barrel.ts" : "barrel.tsx");
    await writeFile(entry, target === "vue"
      ? 'import { h } from "vue"; import { renderToString } from "vue/server-renderer"; import { Button } from "@example/controls"; export const render = () => renderToString(h(Button, { label: "Save" }));'
      : 'import React from "react"; import { renderToStaticMarkup } from "react-dom/server"; import { Button } from "@example/controls"; export const render = () => renderToStaticMarkup(<Button label="Save" />);');
    await build({ root, configFile: false, logLevel: "silent", plugins: [htmlNext({ target }), target === "vue" ? vue() : react()],
      build: { ssr: entry, outDir: "dist", minify: false } });
    const output = await import(pathToFileURL(join(root, "dist", "barrel.js")).href) as { render(): string | Promise<string> };
    assert.match(await output.render(), /Save/);
  }, 60_000);

  it("prepares types without starting Vite and refreshes generated sources after an edit", async () => {
    const { root, library } = await fixture();
    // Workspace/pnpm libraries resolve outside node_modules; they must remain library resources.
    const linkedLibrary = join(root, "linked-controls");
    await rename(library, linkedLibrary);
    await symlink(linkedLibrary, library, "dir");
    await syncHtmlNext({ root, target });
    assert.match(await readFile(join(root, "src", "html-next.d.ts"), "utf8"), /Button/);
    const server = await createServer({ root, configFile: false, logLevel: "silent", plugins: [htmlNext({ target }), target === "vue" ? vue() : react()] });
    try {
      await server.pluginContainer.resolveId("@example/controls");
      const initial = await server.ssrLoadModule("@example/controls");
      assert.ok(initial.Button);
      const initialMarkup = target === "vue" ? await renderToString(h(initial.Button, { label: "Save" }))
        : renderToStaticMarkup(createElement(initial.Button as ComponentType<{ label: string }>, { label: "Save" }));
      assert.match(initialMarkup, /Badge/);
      const source = join(library, "controls.html");
      await writeFile(source, (await readFile(source, "utf8")).replace(">Badge</span>", ">Updated</span>"));
      const plugin = server.config.plugins.find((entry) => entry.name === "html-next-framework");
      const hook = plugin?.handleHotUpdate;
      assert.equal(typeof hook, "function");
      await (hook as (context: unknown) => Promise<unknown>)({ file: source, server, modules: [] });
      const resolved = await server.pluginContainer.resolveId("@example/controls");
      assert.ok(resolved);
      const current = await server.ssrLoadModule("@example/controls");
      assert.ok(current.Button);
      const markup = target === "vue" ? await renderToString(h(current.Button, { label: "Save" }))
        : renderToStaticMarkup(createElement(current.Button as ComponentType<{ label: string }>, { label: "Save" }));
      assert.match(markup, /Updated/);
      await assert.rejects(readFile(join(linkedLibrary, "controls.d.html.ts")), { code: "ENOENT" });
    } finally { await server.close(); }
  }, 60_000);
});

for (const target of ["vue", "react"] as const) it.skipIf(process.env.HTMLNEXT_TARGET_TEST !== "1")(`${target} auto-import preserves browser interactions and CSS`, async () => {
  const { root } = await fixture();
  const entry = target === "vue"
    ? `import { createApp, h } from "vue"; import { Button } from "@example/controls"; createApp({ render: () => h(Button, { label: "Save" }) }).mount("#app");`
    : `import React from "react"; import { createRoot } from "react-dom/client"; import { Button } from "@example/controls"; createRoot(document.getElementById("app")!).render(<Button label="Save" />);`;
  const filename = target === "vue" ? "mount.ts" : "mount.tsx";
  await writeFile(join(root, "src", filename), entry);
  await writeFile(join(root, "index.html"), `<div id="app"></div><script type="module" src="/src/${filename}"></script>`);
  const server = await createServer({ root, configFile: false, logLevel: "silent", plugins: [htmlNext({ target }), target === "vue" ? vue() : react()], server: { port: 0, host: "127.0.0.1" } });
  const browser = await chromium.launch();
  try {
    await server.listen();
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(server.resolvedUrls!.local[0]!);
    await page.waitForFunction(() => document.querySelector("output")?.textContent === "0");
    await page.locator("button").click();
    await page.waitForFunction(() => document.querySelector("output")?.textContent === "1");
    await page.locator("button").click();
    await page.waitForFunction(() => document.querySelector("output")?.textContent === "2");
    assert.equal(await page.locator("ui-button, ui-badge").count(), 0);
    assert.equal(await page.locator("button").evaluate((element) => getComputedStyle(element).color), "rgb(1, 2, 3)");
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await server.close(); }
}, 60_000);

for (const target of ["vue", "react"] as const) it(`${target} supports named local HTML imports and TypeScript sidecars`, async () => {
  const { root, library } = await fixture();
  await writeFile(join(root, "src", "controls.html"), await readFile(join(library, "controls.html"), "utf8"));
  const result = await syncHtmlNext({ target, root, entries: ["src/controls.html"] });
  assert.match(await readFile(join(root, "src", "controls.d.html.ts"), "utf8"), /export \*/);
  const entry = target === "react" ? "local.tsx" : "local.vue";
  await writeFile(join(root, "src", entry), target === "react"
    ? `import { UiButton } from "./controls.html"; export const good = <UiButton label="Save" />;`
    : `<script setup lang="ts">import { UiButton } from "./controls.html";</script><template><UiButton label="Save" /></template>`);
  await writeFile(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { noEmit: true, strict: true,
    skipLibCheck: false, allowArbitraryExtensions: true, module: "ESNext", moduleResolution: "Bundler", target: "ES2022", jsx: "react-jsx" }, include: ["src"] }));
  const compiler = require.resolve(target === "vue" ? "vue-tsc/bin/vue-tsc.js" : "typescript/bin/tsc");
  await run(process.execPath, [compiler, "-p", join(root, "tsconfig.json")], { cwd: root });
  assert.ok(result.sourceFiles.some((path) => path.endsWith(join("src", "controls.html"))));
  const server = await createServer({ root, configFile: false, logLevel: "silent", plugins: [htmlNext({ target }), target === "vue" ? vue() : react()] });
  try {
    const resolved = await server.pluginContainer.resolveId("./controls.html", join(root, "src", "main.ts"));
    assert.ok(resolved?.id.endsWith("index.ts"));
    const raw = await server.pluginContainer.resolveId("./controls.html?raw", join(root, "src", "main.ts"));
    assert.ok(raw);
    assert.ok(raw.id.endsWith("?raw"));
    const rawSource = await realpath(raw.id.slice(0, -"?raw".length));
    assert.equal(normalizePath(rawSource), normalizePath(await realpath(join(root, "src", "controls.html"))));
  } finally { await server.close(); }
}, 60_000);

it("converts a local HTML resource when a React TSX entry first imports it", async () => {
  const { root, library } = await fixture();
  // No declared source package or sync call: the import itself must trigger conversion.
  await writeFile(join(root, "package.json"), JSON.stringify({ type: "module" }));
  await writeFile(join(root, "src", "controls.html"), await readFile(join(library, "controls.html"), "utf8"));
  const entry = join(root, "src", "entry.tsx");
  await writeFile(entry, `import React from "react"; import { renderToStaticMarkup } from "react-dom/server";
    import { UiButton } from "./controls.html";
    export const render = () => renderToStaticMarkup(<UiButton label="Save" />);`);
  await build({ root, configFile: false, logLevel: "silent", plugins: [htmlNext({ target: "react" }), react()],
    build: { ssr: entry, outDir: "dist", minify: false } });
  const output = await import(pathToFileURL(join(root, "dist", "entry.js")).href) as { render(): string };
  const markup = output.render();
  assert.match(markup, /Save/);
  assert.match(markup, /Badge/);
  assert.doesNotMatch(markup, /<ui-button|<ui-badge/);
  assert.match(await readFile(join(root, "src", "controls.d.html.ts"), "utf8"), /export \*/);
  assert.doesNotMatch(await readFile(join(root, "dist", "entry.js"), "utf8"), /UNUSED_COMPONENT_MARKER/);
}, 60_000);

for (const target of ["vue", "react"] as const) it(`${target} supplies the sanitizer dependency for source-only HTML helpers`, async () => {
  const { root, library } = await fixture();
  await writeFile(join(library, "index.js"), 'export { UiButton as Button } from "./controls.html";');
  await writeFile(join(library, "controls.html"), `<template component="ui-button" status="early" summary="Content."><defs>
    <prop name="label" type="string" required>Content.</prop></defs><section><div $html="$label"></div></section></template>`);
  const server = await createServer({ root, configFile: false, logLevel: "silent", plugins: [htmlNext({ target }), target === "vue" ? vue() : react()] });
  try {
    const current = await server.ssrLoadModule("@example/controls");
    const props = { label: '<b>Safe</b><script>unsafe()</script>' };
    const markup = target === "vue" ? await renderToString(h(current.Button, props))
      : renderToStaticMarkup(createElement(current.Button as ComponentType<{ label: string }>, props));
    assert.match(markup, /<b>Safe<\/b>/);
    assert.doesNotMatch(markup.match(/<div>([\s\S]*)<\/div>/)?.[1] ?? "", /unsafe|<script/);
  } finally { await server.close(); }
}, 60_000);


describe("svelte source adapter", () => {
  it.skipIf(process.env.HTMLNEXT_TARGET_TEST !== "1")("mounts on-demand local imports in Vite and updates native output", async () => {
    const { root, library } = await fixture();
    await writeFile(join(root, "package.json"), JSON.stringify({ type: "module" }));
    await writeFile(join(root, "src", "controls.html"), await readFile(join(library, "controls.html"), "utf8"));
    await writeFile(join(root, "src", "App.svelte"), `<script lang="ts">import { UiButton } from "./controls.html";</script><UiButton label="Save" />`);
    await writeFile(join(root, "src", "mount.ts"), `import { mount } from "svelte"; import App from "./App.svelte"; mount(App, { target: document.getElementById("app")! });`);
    await writeFile(join(root, "index.html"), `<div id="app"></div><script type="module" src="/src/mount.ts"></script>`);
    const server = await createServer({ root, configFile: false, logLevel: "silent", plugins: [htmlNext({ target: "svelte" }), svelte()], server: { port: 0, host: "127.0.0.1" } });
    const browser = await chromium.launch();
    try {
      await server.listen();
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(server.resolvedUrls!.local[0]!);
      await page.waitForFunction(() => document.querySelector("output")?.textContent === "0");
      await page.locator("button").click();
      await page.waitForFunction(() => document.querySelector("output")?.textContent === "1");
      assert.equal(await page.locator("ui-button, ui-badge").count(), 0);
      assert.equal(await page.locator("button").evaluate((element) => getComputedStyle(element).color), "rgb(1, 2, 3)");
      assert.deepEqual(errors, []);
      assert.match(await readFile(join(root, "src", "controls.d.html.ts"), "utf8"), /export \*/);
    } finally { await browser.close(); await server.close(); }
  }, 60_000);

  it("converts package and local imports with precise declarations and tree shaking", async () => {
    const { root, library } = await fixture();
    const authored = (await readFile(join(library, "controls.html"), "utf8"))
      .replace('<handler name="increment">', '<event name="change" type="integer" cancelable="true">Count.</event><handler name="increment">')
      .replace('<set name="count" expr:value="$count + 1"></set>', '<set name="count" expr:value="$count + 1" $if="count >= 0"></set><dispatch event="change" expr:value="count"></dispatch><focus ref="label"></focus>')
      .replace('on:click="increment"', 'on:click.self="increment"').replace('<span $value="$label">', '<span $ref="label" $value="$label">')
      .replace('<span>Badge</span>', `<defs><data name="feed" src="/api/feed" type="object({ label: string })"><param name="text" expr:value="form.text"></param></data><state name="form" type="object({ text: string, choices: list(string) })" value="{ text: 'Ready', choices: ['b'] }"></state></defs>
        <section .scrollTop="10">Badge<output $value="feed.value.label"></output><p .textContent="form.text"></p><input value="authored" .title="form.text" bind:value="form.text"><textarea bind:value="form.text">default area</textarea>
          <select multiple bind:value="form.choices"><option value="a" selected>A</option><option value="b">B</option></select>
          <ui-rows><template slot="row"><li .title="item.name" $value="item.name"></li></template></ui-rows></section>`)
      + `<template component="ui-rows" status="early" summary="Scoped rows."><defs>
        <state name="rows" type="list(unknown)" value="[{ id: 'a', name: 'Ada' }]"></state></defs>
        <ul><slot name="row" $each="row of rows" $key="row.id" from:item="row"><li>Fallback</li></slot></ul></template>
        <template component="ui-selected" status="early" summary="Selected input."><defs>
          <prop name="kind" type="keyword" values="text, number" default="text">Kind.</prop>
          <prop name="value">Value.<type from="kind"><option value="text" type="string"></option><option value="number" type="number"></option></type></prop>
          </defs><output $value="value"></output></template>
        <template component="ui-structured" status="early" summary="Selected structured input." controller="./controlled.js"><defs>
          <state name="kind" type="keyword" values="list, object, text" value="list"></state>
          <prop name="value">Value.<type from="kind"><option value="list" type="list(number)"></option><option value="object" type="object({ label: string })"></option><option value="text" type="string"></option></type></prop>
          </defs><output $value="value"></output></template>
        <template component="ui-structured-owner" status="early" summary="Structured input binding."><defs><state name="box" type="object({ value: unknown })" value="{ value: '[1, 2]' }"></state></defs><section><ui-structured from:value="box.value"></ui-structured><ui-structured bind:value="box.value"></ui-structured></section></template>
        <template component="ui-no-controller" status="early" summary="Method readiness."><defs><method name="ping" returns="promise(undefined)"></method></defs><button class="">Ping</button></template>
        <template component="ui-context" status="early" summary="Context alias."><defs><context name="count" from="ui-button" as="activeCount"></context><computed name="twice" from="activeCount + 1"></computed></defs><output $value="twice"></output></template>
        <template component="ui-switch" status="early" summary="Focused root." controller="./controlled.js"><defs><state name="linked" type="boolean" value="false"></state></defs><template $match><a $when="linked" $ref="link" href="#next">Link</a><button $else $ref="button">Button</button></template></template>
        <template component="ui-controlled" status="early" summary="Controller methods." controller="./controlled.js"><defs><prop name="amount" type="number" default="1">Amount.</prop><state name="count" type="number" value="0"></state><method name="increment" export="increment" returns="promise(number)"></method></defs><section><button $ref="button" $value="count"></button><span $each="row of [count]" $ref="rows" $value="row"></span></section></template>
        <template component="ui-reserved" status="early" summary="Public slot names."><defs><prop name="children" type="string">Public children.</prop><prop name="slots" type="string">Public slots.</prop></defs><section><output $value="concat(children, '/', slots)"></output><slot name="title"></slot><slot></slot></section></template>
        <template component="ui-names" status="early" summary="Import collisions."><defs><state name="UiReserved" value="Ready"></state><state name="Map" value="1"></state><state name="String" value="Ready"></state><state name="Symbol" value="Kept"></state><state name="absent" type="number"></state><handler name="UiControlled"><set name="absent" expr:value="1"></set></handler></defs><section><ui-reserved from:children="UiReserved" slots="Public"><b slot="title">Title</b><span $value="UiReserved"></span></ui-reserved><ui-controlled $ref="controlled" on:click="UiControlled"></ui-controlled><output .title="absent" $value="concat(String, '/', Map, '/', Symbol)"></output></section></template>
        <template component="ui-bound" status="early" summary="Component binding."><defs><state name="form" type="object({ amount: number })" value="{ amount: 2 }"></state></defs><section><ui-controlled bind:amount="form.amount"></ui-controlled><ui-native-delegate bind:value="form.amount"></ui-native-delegate><ui-owned-input bind:value="form.amount"></ui-owned-input><ui-untyped-number bind:value="form.amount"></ui-untyped-number><ui-untyped-output bind:value="form.amount"></ui-untyped-output><ui-untyped-output bind:__proto__="form.amount" bind:constructor="form.amount"></ui-untyped-output><ui-untyped-output from:value="form.amount"></ui-untyped-output><ui-untyped-flag bind:checked="form.amount"></ui-untyped-flag><ui-untyped-radio bind:checked="form.amount"></ui-untyped-radio><ui-untyped-file bind:value="form.amount"></ui-untyped-file><ui-untyped-area bind:value="form.amount"></ui-untyped-area><ui-untyped-select bind:value="form.amount"></ui-untyped-select><ui-untyped-select from:value="form.amount"></ui-untyped-select><ui-plain-select from:value="form.amount"></ui-plain-select><select from:value="form.amount"><option value="1" selected>One</option><option value="2">Two</option></select><ui-untyped-multiple bind:value="form.amount"></ui-untyped-multiple><ui-selected kind="number" bind:value="form.amount"></ui-selected><ui-state-selected bind:value="form.amount"></ui-state-selected></section></template>
        <template component="ui-native-switch" status="early" summary="Changing native root."><defs><prop name="mode" type="keyword" values="field, area" default="field">Root.</prop></defs><template $match><input $when="mode = 'field'" value="Default"><textarea $else>Default area</textarea></template></template>
        <template component="ui-native-delegate" status="early" summary="Native binding delegate."><ui-native-switch></ui-native-switch></template>
        <template component="ui-owned-input" status="early" summary="Locally controlled native root."><defs><state name="local" type="string" value="Own"></state></defs><input value="Own default" .value="local" .title="local" from:data-local="local"></template>
        <template component="ui-untyped-number" status="early" summary="Undeclared number."><input type="number" value="9"></template>
        <template component="ui-untyped-output" status="early" summary="Undeclared generic."><output value="literal">Generic</output></template>
        <template component="ui-untyped-flag" status="early" summary="Undeclared checkbox."><input type="checkbox"></template>
        <template component="ui-untyped-radio" status="early" summary="Undeclared radio."><input type="radio"></template>
        <template component="ui-untyped-file" status="early" summary="Undeclared file."><input type="file"></template>
        <template component="ui-untyped-area" status="early" summary="Undeclared textarea."><textarea>Default</textarea></template>
        <template component="ui-plain-select" status="early" summary="Ordinary select root."><select value="2"><option value="1" selected>One</option><option value="2">Two</option></select></template>
        <template component="ui-untyped-select" status="early" summary="Undeclared select."><select><option value="1">One</option><option value="2" selected>Two</option></select></template>
        <template component="ui-untyped-multiple" status="early" summary="Undeclared multiple select."><select multiple><option value="1">One</option><option value="2" selected>Two</option></select></template>
        <template component="ui-decorated" status="early" summary="Delegated decoration."><defs><state name="active" type="boolean" value="false"></state><state name="color" type="string" value="red"></state></defs><ui-controlled class="decorated active" style="color: blue !important" class:active="active" style:color="color"></ui-controlled></template>
        <template component="ui-cycle" status="early" summary="Computed cycle."><defs>
          <computed name="left" from="right + 1"></computed><computed name="right" from="left + 1"></computed></defs><output $value="left"></output></template>
        <template component="ui-depth" status="early" summary="Recursive graph."><defs>
          <prop name="level" type="number" default="0">Depth.</prop></defs>
          <section><span $value="level"></span><ui-depth $if="level < 2" from:level="level + 1"></ui-depth></section></template>
        <template component="ui-state-selected" status="early" summary="State-selected input."><defs>
          <state name="kind" type="keyword" values="text, number" value="number"></state>
          <prop name="value">Value.<type from="kind"><option value="text" type="string"></option><option value="number" type="number"></option></type></prop>
          <handler name="switch"><set name="kind" value="text"></set></handler>
          </defs><output on:click="switch" $value="value"></output></template>
        <template component="ui-primary" status="early" summary="Primary."><defs>
          <prop name="label" type="string" required>Label.</prop><state name="active" type="boolean" value="false"></state>
          <event name="change" type="boolean">Change.</event><handler name="toggle"><set name="active" expr:value="active = false"></set><dispatch event="change" expr:value="active"></dispatch><focus ref="root"></focus></handler>
        </defs><ui-button $ref="root" from:label="label" class="primary" class:active="active" on:click="toggle"><slot></slot></ui-button></template>`;
    await writeFile(join(library, "controls.html"), authored);
    await writeFile(join(root, "src", "controls.html"), await readFile(join(library, "controls.html"), "utf8"));
    const controllerSource = "export default function connect(host) {} export async function increment(host) { return ++host.state.count; }";
    await writeFile(join(library, "controlled.js"), controllerSource);
    await writeFile(join(root, "src", "controlled.js"), controllerSource);
    const prepared = await syncHtmlNext({ target: "svelte", root, entries: ["src/controls.html"] });
    assert.ok(prepared.aliases.has("@example/controls"));
    assert.match(await readFile(prepared.declarationsFile, "utf8"), /export const Button:/);
    assert.match(await readFile(join(root, "src", "controls.d.html.ts"), "utf8"), /export \*/);
    const checker = require.resolve("svelte-check/bin/svelte-check");
    const cache = dirname(dirname(prepared.aliases.get("@example/controls")!));
    // Svelte deliberately suppresses diagnostics under node_modules, including the adapter cache.
    // Validate a standalone copy and prove that the checker rejects an invalid native consumer.
    const validation = join(root, "checked-svelte");
    await cp(cache, validation, { recursive: true, filter: (source) => basename(source) !== "node_modules" });
    const config = JSON.parse(await readFile(join(cache, "tsconfig.json"), "utf8")) as { files: string[]; compilerOptions: Record<string, unknown> };
    const validationConfig = join(validation, "tsconfig.json");
    const validationFiles = config.files.map((file) => join(validation, relative(cache, file)));
    await writeFile(validationConfig, JSON.stringify({ ...config, files: validationFiles,
      compilerOptions: { ...config.compilerOptions, rootDir: validation, outDir: join(validation, "types") } }));
    const checkSvelte = async (project: string): Promise<void> => {
      try { await run(process.execPath, [checker, "--tsconfig", project, "--output", "machine"], { cwd: root }); }
      catch (error) { assert.fail((error as { stdout?: string }).stdout ?? String(error)); }
    };
    await checkSvelte(validationConfig);
    const selectedConsumer = join(validation, "SelectedConsumer.svelte");
    const selected = validationFiles.find((file) => file.endsWith("/UiSelected.svelte"))!;
    assert.ok(selected);
    const selectedImport = `./${relative(validation, selected).split("\\").join("/")}`;
    const selectedConfig = join(validation, "tsconfig.consumer.json");
    await writeFile(selectedConfig, JSON.stringify({ ...config, files: [selectedConsumer],
      compilerOptions: { ...config.compilerOptions, rootDir: validation, outDir: join(validation, "types") } }));
    await writeFile(selectedConsumer, `<script lang="ts">import UiSelected from ${JSON.stringify(selectedImport)};</script><UiSelected kind="number" value={2} /><UiSelected kind="text" value="Ready" />`);
    await checkSvelte(selectedConfig);
    await writeFile(selectedConsumer, `<script lang="ts">import UiSelected from ${JSON.stringify(selectedImport)};</script><UiSelected kind="number" value="Ready" />`);
    await assert.rejects(run(process.execPath, [checker, "--tsconfig", selectedConfig, "--output", "machine"], { cwd: root }), (error: unknown) => {
      assert.match((error as { stdout: string }).stdout, /string.*number/);
      return true;
    });
    await rm(selectedConsumer);
    await rm(selectedConfig);
    const entry = join(root, "src", "entry.ts");
    await writeFile(entry, `import { render } from "svelte/server";
      import { Button } from "@example/controls";
      import { UiBadge, UiDecorated } from "./controls.html";
      export const markup = () => render(Button, { props: { label: "Save", size: "large" } }).body + render(UiBadge).body + render(UiDecorated).body;`);
    await build({ root, configFile: false, logLevel: "silent", plugins: [htmlNext({ target: "svelte" }), svelte()],
      build: { ssr: entry, outDir: "dist", minify: false } });
    const output = await import(pathToFileURL(join(root, "dist", "entry.js")).href) as { markup(): string };
    assert.match(output.markup(), /Save/);
    assert.match(output.markup(), /Badge/);
    assert.match(output.markup(), /class="decorated"/);
    assert.match(output.markup(), /style="color: red;"/);
    const bundle = await readFile(join(root, "dist", "entry.js"), "utf8");
    assert.equal(/<ui-button|<ui-badge|UNUSED_COMPONENT_MARKER|parse(?:BrowserComponent|Component(?:Nodes|Resource)?)\b|html-next\/live/.test(bundle), false, "unused components and HTML Next runtime must be absent");
    await writeFile(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: {
      strict: true, skipLibCheck: true, allowArbitraryExtensions: true, module: "ESNext", moduleResolution: "Bundler", target: "ES2022", noEmit: true,
    }, include: ["src"] }));
    await writeFile(join(root, "src", "consumer.ts"), `import type { ComponentProps } from "svelte";
      import { Button } from "@example/controls"; import { UiButton, UiControlled, UiReserved } from "./controls.html";
      export const method: Promise<number> = (null! as ReturnType<typeof UiControlled>).increment();
      export const good: ComponentProps<typeof Button> = { label: "Save", size: "large" };
      export const local: ComponentProps<typeof UiButton> = { label: "Save" };
      export const reserved: ComponentProps<typeof UiReserved> = { children: "Child", slots: "Slots" };`);
    const compiler = require.resolve("typescript/bin/tsc");
    await run(process.execPath, [compiler, "-p", join(root, "tsconfig.json")], { cwd: root });
    await writeFile(join(root, "src", "invalid.ts"), `import type { ComponentProps } from "svelte"; import { Button } from "@example/controls";
      export const bad: ComponentProps<typeof Button> = { label: 42, size: "huge" };`);
    await assert.rejects(run(process.execPath, [compiler, "-p", join(root, "tsconfig.json")], { cwd: root }), (error: unknown) => {
      const result = error as { stdout: string };
      assert.match(result.stdout, /number.*string/);
      assert.match(result.stdout, /huge/);
      return true;
    });
    await writeFile(join(root, "src", "invalid.ts"), `import { UiControlled } from "./controls.html";
      export const bad: Promise<string> = (null! as ReturnType<typeof UiControlled>).increment();`);
    await assert.rejects(run(process.execPath, [compiler, "-p", join(root, "tsconfig.json")], { cwd: root }), (error: unknown) => {
      assert.match((error as { stdout: string }).stdout, /Promise<number>.*Promise<string>/);
      return true;
    });
    await writeFile(join(root, "src", "invalid.ts"), `import type { ComponentProps } from "svelte"; import { UiReserved } from "./controls.html";
      export const bad: ComponentProps<typeof UiReserved> = { children: 42, slots: "Slots" };`);
    await assert.rejects(run(process.execPath, [compiler, "-p", join(root, "tsconfig.json")], { cwd: root }), (error: unknown) => {
      assert.match((error as { stdout: string }).stdout, /number.*string/);
      return true;
    });
    await rm(join(root, "src", "invalid.ts"));
    await writeFile(join(library, "controls.html"), (await readFile(join(library, "controls.html"), "utf8")).replace('values="small, large"', 'values="small, large, huge"'));
    await syncHtmlNext({ target: "svelte", root });
    await writeFile(join(root, "src", "consumer.ts"), `import type { ComponentProps } from "svelte"; import { Button } from "@example/controls";
      export const refreshed: ComponentProps<typeof Button> = { label: "Save", size: "huge" };`);
    await run(process.execPath, [compiler, "-p", join(root, "tsconfig.json")], { cwd: root });
  }, 60_000);
});
