import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, it } from "vitest";

import { compileScript, parse as parseVue } from "@vue/compiler-sfc";
import { build } from "esbuild";
import { chromium, firefox, webkit, type BrowserType, type Page } from "playwright";

import { generateComponent, parseComponentResource, type ComponentDefinition } from "@nextwebwg/html-next";
import { convertComponents } from "../src/index.js";
import { sveltePlugin } from "./helpers/svelte.js";
import { launchParityBrowser } from "../../html-next/tests/pixel-parity.js";

/**
 * Declared slot props (https://nextwebwg.org/declarative-components/components#slot-props): a static
 * prop converted by its declared type, a bound one, and a default, read by a consumer's
 * `<template slot>` the same in the live runtime, compiled output and each converted framework.
 */
const rowSource = `<template component="x-disclosure" status="early" summary="A disclosure."><defs>
  <prop name="items" type="list(string)" default="[]">The items.</prop>
  <slot name="summary">
    <prop name="label" type="string" default="Details">The summary's text.</prop>
    <prop name="count" type="number" required>How many items there are.</prop>
    <prop name="limit" type="integer" default="0">The most items shown.</prop>
    <prop name="tone" type="keyword" values="quiet, loud" default="quiet">The tone.</prop>
  </slot>
</defs><div class="disclosure"><span class="summary"><slot name="summary" label="Open" limit="5" from:count="$items.length">Details</slot></span></div></template>`;
const linkFormSource = `<link rel="component" href="./row.html">
<template component="x-page" status="early" summary="A page."><defs>
  <state name="items" type="list(string)" value="['a']"></state>
  <handler name="add"><set name="items" expr:value="['a', 'b', 'c']"></set></handler>
</defs><main><button type="button" class="add" on:click="add">Add</button>
  <x-disclosure from:items="$items"><template slot="summary"><b class="label">{$label}</b><i class="count">{$count + $limit}</i><u class="tone">{$tone}</u></template></x-disclosure></main></template>`;
const files: Readonly<Record<string, string>> = { "row.html": rowSource, "form.html": linkFormSource };
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

/** The summary's label, count plus limit, and tone, once the count reads `count`. */
async function summary(page: Page, count: string): Promise<readonly string[]> {
  try {
    await page.waitForFunction((expected) => document.querySelector(".summary .count")?.textContent?.trim() === expected, count, { timeout: 5_000 });
  } catch {
    throw new Error(`Expected count ${count}, got ${await page.evaluate(() => document.querySelector("#mount")?.innerHTML)}`);
  }
  return page.evaluate(() => [".label", ".count", ".tone"].map((selector) => document.querySelector(`.summary ${selector}`)?.textContent?.trim() ?? ""));
}

describe.skipIf(!enabled)("declared slot props in the live runtime, compiled output and converted frameworks", () => {
  let directory = "";
  const bundles = new Map<string, string>();

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-slot-props-"));
    await symlink(nodeModules, join(directory, "node_modules"), "dir");
    for (const [name, contents] of Object.entries(files)) await writeFile(join(directory, name), contents);
    const live = join(directory, "live.js");
    await build({ entryPoints: [join(htmlNextSource, "browser-loader.ts")],
      outfile: live, bundle: true, format: "iife", globalName: "HtmlNextLoader", platform: "browser", target: ["es2022"] });
    bundles.set("live", live);

    const definitions: ComponentDefinition[] = [];
    for (const name of ["row.html", "form.html"]) definitions.push(...parseComponentResource(files[name]!, `file://${join(directory, name)}`).definitions);
    const invocations = new Map(definitions.map((definition) => [definition.contract.tag, { module: `./${definition.contract.name}.js`, definition }]));
    for (const definition of definitions) {
      const module = generateComponent(definition, { invocations }).find((artifact) => artifact.path === `vanilla/${definition.contract.name}.js`)!;
      await writeFile(join(directory, `${definition.contract.name}.js`), module.content);
    }
    await writeFile(join(directory, "vanilla-entry.js"), `import { createXPage } from "./XPage.js";\ndocument.querySelector("#mount").append(createXPage());\n`);
    const vanilla = join(directory, "vanilla.js");
    await build({ entryPoints: [join(directory, "vanilla-entry.js")], outfile: vanilla, bundle: true, format: "iife", platform: "browser", target: ["es2022"],
      alias: { "@nextwebwg/html-next/generated-runtime": join(htmlNextSource, "generated-runtime.ts") }, plugins: [emptyStyles] });
    bundles.set("vanilla", vanilla);

    for (const target of ["vue", "react", "svelte"] as const) {
      const out = join(directory, target);
      const manifest = await convertComponents({ mode: "application", target, root: directory, outDirectory: out, entries: ["form.html"] });
      const form = manifest.components.find((component) => component.tag === "x-page")!.artifact;
      const entry = join(out, "entry.ts");
      const bundle = join(out, "bundle.js");
      if (target === "vue") {
        for (const component of manifest.components) {
          const path = join(out, component.artifact);
          const parsed = parseVue(await readFile(path, "utf8"), { filename: path });
          assert.deepEqual(parsed.errors, []);
          await writeFile(path.replace(/\.vue$/, ".ts"), compileScript(parsed.descriptor, { id: component.tag, inlineTemplate: true }).content);
        }
        await writeFile(entry, `import { createApp, h } from "vue"; import Form from "./${form}";
createApp({ render: () => h(Form) }).mount(document.querySelector("#mount")!);\n`);
        await build({ entryPoints: [entry], outfile: bundle, bundle: true, format: "iife", platform: "browser", target: ["es2022"],
          nodePaths: [nodeModules], plugins: [vuePlugin], loader: { ".css": "empty" } });
      } else if (target === "react") {
        await writeFile(join(out, "entry.tsx"), `import { createRoot } from "react-dom/client"; import Form from "./${form}";
createRoot(document.querySelector("#mount")!).render(<Form />);\n`);
        await build({ entryPoints: [join(out, "entry.tsx")], outfile: bundle, bundle: true, format: "iife", platform: "browser",
          target: ["es2022"], jsx: "automatic", nodePaths: [nodeModules], loader: { ".css": "empty" } });
      } else {
        await writeFile(entry, `import { mount } from "svelte"; import Form from "./${form}";
mount(Form, { target: document.querySelector("#mount")! });\n`);
        await build({ entryPoints: [entry], outfile: bundle, bundle: true, format: "iife", platform: "browser", target: ["es2022"],
          loader: { ".css": "empty" }, plugins: [sveltePlugin("client")] });
      }
      bundles.set(target, bundle);
    }
  }, 180_000);
  afterAll(async () => { if (directory !== "") await rm(directory, { recursive: true, force: true }); });

  for (const [engine, browserType] of [["Chromium", chromium], ["Firefox", firefox], ["WebKit", webkit]] as const satisfies ReadonlyArray<readonly [string, BrowserType]>) {
    for (const target of ["live", "vanilla", "vue", "react", "svelte"] as const) {
      it(`${engine} ${target} gives the template its slot's static, bound and default props`, async () => {
        const browser = await launchParityBrowser(browserType);
        const errors: string[] = [];
        try {
          const page = await browser.newPage();
          page.on("pageerror", (error) => errors.push(error.message));
          page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
          await page.route("https://app.example/**", (route) => {
            const name = new URL(route.request().url()).pathname.slice(1);
            return route.fulfill({ contentType: "text/html", body: Object.hasOwn(files, name) ? files[name]! : target === "live"
              ? '<link rel="component" href="/form.html"><div id="mount"><x-page></x-page></div>'
              : '<div id="mount"></div>' });
          });
          await page.goto("https://app.example/");
          await page.addScriptTag({ path: bundles.get(target)! });
          if (target === "live") {
            await page.evaluate(() => (window as unknown as { HtmlNextLoader: { startBrowserComponents(): Promise<unknown> } }).HtmlNextLoader.startBrowserComponents());
          }
          assert.deepEqual(await summary(page, "6"), ["Open", "6", "quiet"]);
          await page.locator(".add").click();
          assert.deepEqual(await summary(page, "8"), ["Open", "8", "quiet"]);
          assert.deepEqual(errors, []);
        } finally {
          await browser.close();
        }
      });
    }
  }
});
