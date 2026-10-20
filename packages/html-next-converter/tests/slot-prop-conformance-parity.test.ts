import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, it } from "vitest";

import { compileScript, parse as parseVue } from "@vue/compiler-sfc";
import { build as esbuild } from "esbuild";
import { chromium, firefox, webkit, type BrowserType } from "playwright";

import { generateComponent, parseComponentResource, type ComponentDefinition } from "@nextwebwg/html-next";
import { convertComponents } from "../src/index.js";
import { sveltePlugin } from "./helpers/svelte.js";
import { launchParityBrowser } from "../../html-next/tests/pixel-parity.js";

/**
 * A bound slot prop is checked in full against its declared type, as a prop's input is
 * (https://nextwebwg.org/declarative-components/types): a closed object rejects an undeclared field,
 * a missing required field and a field of the wrong type. A rejected value warns HR007 once, naming
 * the slot and the prop, and the consumer reads the prop's default, or absent without one, the same
 * in every target and in development and production builds. A value that stops conforming does too;
 * it does not keep the last one that conformed. A null value takes the default without a warning.
 */
const list = (tag: string, row: string, later?: string) => `<template component="${tag}" status="early" summary="List."><defs>
  <slot name="row"><prop name="row" type="object" required>The row.<prop name="id" required type="string">Id.</prop><prop name="label" required type="string">Label.</prop></prop></slot>
  <state type="list(unknown)" name="rows" value="[{ id: 'a', label: 'A' }, ${row}]"></state>
  ${later === undefined ? "" : `<handler name="change"><set name="rows" expr:value="[{ id: 'a', label: 'A' }, ${later}]"></set></handler>`}</defs>
  <div><ul class="${tag}"><slot $each="r of $rows" $key="$loop.index" name="row" from:row="$r"></slot></ul>${later === undefined ? "" : `<button type="button" on:click="change">Change</button>`}</div></template>`;
const cases = { extra: "{ id: 'b', label: 'B', index: 1 }", missing: "{ id: 'b' }", wrong: "{ id: 2, label: 'B' }", later: "{ id: 'b', label: 'B' }" } as const;
const page = `${[...Object.keys(cases), "defaults"].map((name) => `<link rel="component" href="./${name}.html">`).join("")}
<template component="x-page" status="early" summary="Page."><main>${Object.keys(cases).map((name) =>
  `<x-${name}><template slot="row"><li $value="$row.label"></li></template></x-${name}>`).join("")}
  <x-defaults><template slot="row"><li><b $value="$label"></b><i $value="$note"></i></li></template></x-defaults></main></template>`;
// A default fills a rejected value and a null or missing one, typed or `unknown`.
const defaults = `<template component="x-defaults" status="early" summary="Defaults."><defs>
  <slot name="row"><prop name="label" type="string" default="Fallback">Label.</prop><prop name="note" type="unknown" default="n">Note.</prop></slot>
  <state type="list(unknown)" name="rows" value="[{ label: 'A', note: 'x' }, { label: 3 }, { label: null, note: null }]"></state></defs>
  <div><ul class="x-defaults"><slot $each="r of $rows" $key="$loop.index" name="row" from:label="$r.label" from:note="$r.note"></slot></ul></div></template>`;
const files: Readonly<Record<string, string>> = { "defaults.html": defaults, ...Object.fromEntries(Object.entries(cases).map(([name, row]) => [`${name}.html`, list(`x-${name}`, row, name === "later" ? "{ id: 'b', label: 'B', extra: true }" : undefined)])), "page.html": page };
const enabled = process.env.HTMLNEXT_TARGET_TEST === "1";
const nodeModules = fileURLToPath(new URL("../node_modules", import.meta.url));
const htmlNextSource = fileURLToPath(new URL("../../html-next/src/", import.meta.url));
const vuePlugin = { name: "compiled-vue-sfc", setup(pluginBuild: { onResolve: (options: { filter: RegExp }, callback: (args: { path: string; resolveDir: string }) => { path: string }) => void }) {
  pluginBuild.onResolve({ filter: /\.vue$/ }, (args) => ({ path: resolve(args.resolveDir, args.path.replace(/\.vue$/, ".ts")) }));
} };
const emptyStyles = { name: "empty-styles", setup(pluginBuild: { onResolve: (options: { filter: RegExp }, callback: (args: { path: string }) => { path: string; namespace: string }) => void; onLoad: (options: { filter: RegExp; namespace: string }, callback: () => { contents: string; loader: "js" }) => void }) {
  pluginBuild.onResolve({ filter: /\.css$/ }, (args) => ({ path: args.path, namespace: "empty-style" }));
  pluginBuild.onLoad({ filter: /.*/, namespace: "empty-style" }, () => ({ contents: "", loader: "js" }));
} };
const modes = ["development", "production"] as const;
const build = (options: Parameters<typeof esbuild>[0], mode: (typeof modes)[number]) => esbuild({ ...options, bundle: true, format: "iife", platform: "browser", target: ["es2022"],
  minify: mode === "production", define: { "process.env.NODE_ENV": JSON.stringify(mode) }, loader: { ".css": "empty", ...options.loader } });

describe.skipIf(!enabled)("bound slot props are checked in full against their declared type in every target", () => {
  let directory = "";
  const bundles = new Map<string, string>();

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-slot-props-"));
    await symlink(nodeModules, join(directory, "node_modules"), "dir");
    for (const [name, contents] of Object.entries(files)) await writeFile(join(directory, name), contents);
    const definitions: ComponentDefinition[] = [];
    for (const name of Object.keys(files)) definitions.push(...parseComponentResource(files[name]!, `file://${join(directory, name)}`).definitions);
    const invocations = new Map(definitions.map((definition) => [definition.contract.tag, { module: `./${definition.contract.name}.js`, definition }]));
    for (const definition of definitions) {
      const module = generateComponent(definition, { invocations }).find((artifact) => artifact.path === `vanilla/${definition.contract.name}.js`)!;
      // A bundled module's import.meta.url, which names its warnings' file, is its own URL.
      await writeFile(join(directory, `${definition.contract.name}.js`), module.content.replaceAll("import.meta.url", JSON.stringify(`file://${join(directory, definition.contract.name)}.js`)));
    }
    await writeFile(join(directory, "vanilla-entry.js"), `import { createXPage } from "./XPage.js";\ndocument.querySelector("#mount").append(createXPage());\n`);
    const forms = new Map<string, string>();
    for (const target of ["vue", "react", "svelte"] as const) {
      const out = join(directory, target);
      const manifest = await convertComponents({ mode: "application", target, root: directory, outDirectory: out, entries: ["page.html"], publicRootURL: "/" });
      forms.set(target, manifest.components.find((component) => component.tag === "x-page")!.artifact);
      if (target === "vue") {
        for (const component of manifest.components) {
          const path = join(out, component.artifact);
          const parsed = parseVue(await readFile(path, "utf8"), { filename: path });
          assert.deepEqual(parsed.errors, []);
          await writeFile(path.replace(/\.vue$/, ".ts"), compileScript(parsed.descriptor, { id: component.tag, inlineTemplate: true }).content);
        }
        await writeFile(join(out, "entry.ts"), `import { createApp, h } from "vue"; import Form from "./${forms.get(target)}";
createApp({ render: () => h(Form) }).mount(document.querySelector("#mount")!);\n`);
      } else if (target === "react") {
        await writeFile(join(out, "entry.tsx"), `import { createRoot } from "react-dom/client"; import Form from "./${forms.get(target)}";
createRoot(document.querySelector("#mount")!).render(<Form />);\n`);
      } else {
        await writeFile(join(out, "entry.ts"), `import { mount } from "svelte"; import Form from "./${forms.get(target)}";
mount(Form, { target: document.querySelector("#mount")! });\n`);
      }
    }
    for (const mode of modes) {
      const bundle = (target: string) => join(directory, `${target}-${mode}.js`);
      await build({ entryPoints: [join(htmlNextSource, "browser-loader.ts")], outfile: bundle("live"), globalName: "HtmlNextLoader" }, mode);
      await build({ entryPoints: [join(directory, "vanilla-entry.js")], outfile: bundle("vanilla"),
        alias: { "@nextwebwg/html-next/generated-runtime": join(htmlNextSource, "generated-runtime.ts") }, plugins: [emptyStyles] }, mode);
      await build({ entryPoints: [join(directory, "vue", "entry.ts")], outfile: bundle("vue"), nodePaths: [nodeModules], plugins: [vuePlugin] }, mode);
      await build({ entryPoints: [join(directory, "react", "entry.tsx")], outfile: bundle("react"), jsx: "automatic", nodePaths: [nodeModules] }, mode);
      await build({ entryPoints: [join(directory, "svelte", "entry.ts")], outfile: bundle("svelte"), plugins: [sveltePlugin("client")] }, mode);
      for (const target of ["live", "vanilla", "vue", "react", "svelte"]) bundles.set(`${target}-${mode}`, bundle(target));
    }
  }, 240_000);
  afterAll(async () => { if (directory !== "") await rm(directory, { recursive: true, force: true }); });

  for (const [engine, browserType] of [["Chromium", chromium], ["Firefox", firefox], ["WebKit", webkit]] as const satisfies ReadonlyArray<readonly [string, BrowserType]>) {
    for (const target of ["live", "vanilla", "vue", "react", "svelte"] as const) {
      for (const mode of modes) {
        it(`${engine} ${target} ${mode} gives only conforming rows and warns once for each rejected slot prop`, async () => {
          const browser = await launchParityBrowser(browserType);
          const errors: string[] = [];
          const warnings: string[] = [];
          try {
            const page = await browser.newPage();
            page.on("pageerror", (error) => errors.push(error.message));
            page.on("console", (message) => {
              if (message.type() === "error") errors.push(message.text());
              if (message.type() === "warning" && message.text().includes("HR007")) warnings.push(message.text());
            });
            await page.route("https://app.example/**", (route) => {
              const name = new URL(route.request().url()).pathname.slice(1);
              return route.fulfill({ contentType: "text/html", body: Object.hasOwn(files, name) ? files[name]! : target === "live"
                ? '<link rel="component" href="/page.html"><div id="mount"><x-page></x-page></div>'
                : '<div id="mount"></div>' });
            });
            await page.goto("https://app.example/");
            await page.addScriptTag({ path: bundles.get(`${target}-${mode}`)! });
            if (target === "live") {
              await page.evaluate(() => (window as unknown as { HtmlNextLoader: { startBrowserComponents(): Promise<unknown> } }).HtmlNextLoader.startBrowserComponents());
            }
            const rows = () => page.evaluate(() => Array.from(document.querySelectorAll("ul"), (list) => [list.className, Array.from(list.children, (row) => row.textContent)]));
            const filled = ["x-defaults", ["Ax", "Fallbackn", "Fallbackn"]];
            await page.waitForFunction(() => document.querySelectorAll("li").length === 11);
            assert.deepEqual(await rows(), [["x-extra", ["A", ""]], ["x-missing", ["A", ""]], ["x-wrong", ["A", ""]], ["x-later", ["A", "B"]], filled]);
            assert.equal(warnings.length, 4);
            await page.click("button");
            await page.waitForFunction(() => document.querySelector(".x-later")!.textContent === "A");
            assert.deepEqual(await rows(), [["x-extra", ["A", ""]], ["x-missing", ["A", ""]], ["x-wrong", ["A", ""]], ["x-later", ["A", ""]], filled]);
            const message = "HR007: Slot `row` prop `row` does not satisfy its declared type `object({ id: string, label: string })`.";
            assert.deepEqual(warnings.map((warning) => [warning.match(/extra|missing|wrong|later|defaults/i)?.[0].toLowerCase(), warning.slice(warning.indexOf("HR007"))]).sort(),
              [...Object.keys(cases).map((name) => [name, message]), ["defaults", "HR007: Slot `row` prop `label` does not satisfy its declared type `string`."]].sort());
            assert.deepEqual(errors, []);
          } finally {
            await browser.close();
          }
        });
      }
    }
  }
});
