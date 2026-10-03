import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import htmlNext from "../src/vite.js";
import { syncHtmlNext } from "../src/framework.js";

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
  for (const name of ["vue", "react", "react-dom", "@types/react", "@types/react-dom"]) {
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
<template component="ui-unused" status="early" summary="Unused."><aside>UNUSED_COMPONENT_MARKER</aside></template>`);
  return { root, library };
}

for (const target of ["vue", "react"] as const) describe(`${target} source adapter`, () => {
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
    assert.equal(normalizePath(raw.id), normalizePath(`${await realpath(join(root, "src", "controls.html"))}?raw`));
  } finally { await server.close(); }
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
