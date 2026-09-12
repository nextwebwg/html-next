import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, before, describe, it } from "node:test";

import { compileScript, parse as parseVue } from "@vue/compiler-sfc";
import { build } from "esbuild";
import { chromium } from "playwright";

import { assembleComponentPackage } from "../src/package.js";

const enabled = process.env.HTMLNEXT_LOOMA_TEST === "1";
const fixture = new URL("./fixtures/package/", import.meta.url).pathname;
const runtimePath = new URL("../src/runtime.ts", import.meta.url).pathname;
const nodeModulesPath = new URL("../node_modules", import.meta.url).pathname;

describe("Knit-shaped Vue package consumer", { skip: !enabled }, () => {
  let directory = "";
  let browserBundle = "";
  let ssrBundle = "";

  before(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-knit-"));
    await assembleComponentPackage({
      name: "@threadlabs/looma",
      version: "1.0.0",
      outDirectory: directory,
      components: [{ source: `${fixture}/ui-button.html` }],
    });
    const source = await readFile(join(directory, "vue/UiButton.vue"), "utf8");
    const parsed = parseVue(source, { filename: "UiButton.vue" });
    assert.deepEqual(parsed.errors, []);
    const component = compileScript(parsed.descriptor, {
      id: "ui-button",
      inlineTemplate: true,
    }).content;
    await writeFile(join(directory, "vue/UiButton.ts"), component);

    const renderEntry = join(directory, "render.ts");
    await writeFile(renderEntry, `import { createSSRApp, h } from "vue";
import { renderToString } from "@vue/server-renderer";
import UiButton from "./vue/UiButton";
export async function render() {
  return renderToString(createSSRApp({ render: () => h(UiButton, { disabled: false }, { default: () => h("span", "Save") }) }));
}`);
    ssrBundle = join(directory, "render.mjs");
    await build({
      entryPoints: [renderEntry], outfile: ssrBundle, bundle: true, format: "esm", platform: "node",
      target: ["node20"], nodePaths: [nodeModulesPath], loader: { ".css": "empty" },
      alias: { "@nextwebwg/html/runtime": runtimePath },
    });

    const browserEntry = join(directory, "hydrate.ts");
    await writeFile(browserEntry, `import { createSSRApp, h } from "vue";
import UiButton from "./vue/UiButton";
createSSRApp({ render: () => h(UiButton, { disabled: false }, { default: () => h("span", "Save") }) }).mount(document.querySelector("main"));`);
    browserBundle = join(directory, "hydrate.js");
    await build({
      entryPoints: [browserEntry], outfile: browserBundle, bundle: true, format: "iife", platform: "browser",
      target: ["es2022"], nodePaths: [nodeModulesPath], loader: { ".css": "empty" },
      alias: { "@nextwebwg/html/runtime": runtimePath },
    });
  });

  after(async () => {
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
