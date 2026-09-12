import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, it } from "vitest";

import { compileScript, parse as parseVue } from "@vue/compiler-sfc";
import { build, type Plugin } from "esbuild";
import { chromium } from "playwright";

import { assembleFixtureLooma } from "./helpers/looma-package.js";

const enabled = process.env.HTMLNEXT_LOOMA_TEST === "1";
const runtimePath = new URL("../src/runtime.ts", import.meta.url).pathname;
const libraryPath = new URL("../src/index.ts", import.meta.url).pathname;
const nodeModulesPath = new URL("../node_modules", import.meta.url).pathname;

describe.skipIf(!enabled)("Knit-shaped Vue package consumer", () => {
  let directory = "";
  let browserBundle = "";
  let ssrBundle = "";
  const vuePlugin: Plugin = {
    name: "fixture-vue-sfc",
    setup(context) {
      context.onLoad({ filter: /\.vue$/ }, async ({ path }) => {
        const source = await readFile(path, "utf8");
        const parsed = parseVue(source, { filename: path });
        if (parsed.errors.length > 0) throw parsed.errors[0];
        return {
          contents: compileScript(parsed.descriptor, { id: path, inlineTemplate: true }).content,
          loader: "ts",
          resolveDir: dirname(path),
        };
      });
    },
  };

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-knit-"));
    await assembleFixtureLooma(directory);

    const renderEntry = join(directory, "render.ts");
    await writeFile(renderEntry, `import { createSSRApp, h } from "vue";
import { renderToString } from "@vue/server-renderer";
import { Button } from "@threadlabs/looma/vue";
import { EditorToolbar } from "@threadlabs/looma/vue/editor";
import { LoomaTable } from "@threadlabs/looma/editor/extensions";
export async function render() {
  if (EditorToolbar.name !== "EditorToolbar" || LoomaTable.name !== "loomaTable") throw new Error("Editor exports failed");
  return renderToString(createSSRApp({ render: () => h(Button, { disabled: false }, { default: () => h("span", "Save") }) }));
}`);
    ssrBundle = join(directory, "render.mjs");
    await build({
      entryPoints: [renderEntry], outfile: ssrBundle, bundle: true, format: "esm", platform: "node",
      target: ["node20"], nodePaths: [nodeModulesPath], loader: { ".css": "empty" },
      plugins: [vuePlugin],
      alias: {
        "@nextwebwg/html/runtime": runtimePath,
        "@nextwebwg/html": libraryPath,
        "@threadlabs/looma/vue/editor": join(directory, "vue/editor/index.js"),
        "@threadlabs/looma/editor/extensions": join(directory, "editor/extensions/index.js"),
        "@threadlabs/looma/vue": join(directory, "vue/index.js"),
      },
    });

    const browserEntry = join(directory, "hydrate.ts");
    await writeFile(browserEntry, `import { createSSRApp, h } from "vue";
import { Button } from "@threadlabs/looma/vue";
createSSRApp({ render: () => h(Button, { disabled: false }, { default: () => h("span", "Save") }) }).mount(document.querySelector("main"));`);
    browserBundle = join(directory, "hydrate.js");
    await build({
      entryPoints: [browserEntry], outfile: browserBundle, bundle: true, format: "iife", platform: "browser",
      target: ["es2022"], nodePaths: [nodeModulesPath], loader: { ".css": "empty" },
      plugins: [vuePlugin],
      alias: {
        "@nextwebwg/html/runtime": runtimePath,
        "@nextwebwg/html": libraryPath,
        "@threadlabs/looma/vue": join(directory, "vue/index.js"),
      },
    });
  });

  afterAll(async () => {
    if (directory !== "") await rm(directory, { recursive: true, force: true });
  });

  it("renders and hydrates the generated Vue adapter without replacing its native root", async () => {
    const module = await import(`${pathToFileURL(ssrBundle).href}?${Date.now()}`) as { render(): Promise<string> };
    const html = await module.render();
    assert.match(html, /^<button/);
    assert.match(html, /<span>Save<\/span>/);

    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent(`<main>${html}</main>`);
      await page.evaluate(() => { (window as unknown as { before: Element | null }).before = document.querySelector("button"); });
      await page.addScriptTag({ path: browserBundle });
      await page.waitForSelector('button[data-component-root~="ui-button"]');
      const result = await page.evaluate(() => ({
        same: (window as unknown as { before: Element | null }).before === document.querySelector("button"),
        label: document.querySelector("button")?.textContent,
        tag: document.querySelector("button")?.localName,
      }));
      assert.deepEqual(result, { same: true, label: "Save", tag: "button" });
    } finally {
      await browser.close();
    }
  });
});
