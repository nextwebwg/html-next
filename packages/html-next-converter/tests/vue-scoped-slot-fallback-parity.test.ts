import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";

import { compileScript, parse as parseVue } from "@vue/compiler-sfc";
import { build } from "esbuild";
import { chromium, firefox, webkit, type BrowserType } from "playwright";

import { convertComponents, type ConversionGraph } from "../src/index.js";

import { assertPixelsEqual, launchParityBrowser } from "../../html-next/tests/pixel-parity.js";

const enabled = process.env.HTMLNEXT_TARGET_TEST === "1";
const nodeModulesPath = new URL("../../html-next/node_modules", import.meta.url).pathname;
const livePath = new URL("../../html-next/src/live.ts", import.meta.url).pathname;
const staticSource = `<template component="x-static-scoped" status="early" summary="Static scoped slot."><div><slot name="row" from:item="'Ada'"><span>Fallback</span></slot></div></template>`;
const dynamicSource = `<template component="x-dynamic-scoped" status="early" summary="Dynamic scoped slot."><defs><state name="slotName" value="row"></state></defs><div><slot from:name="$slotName" from:item="'Ada'"><span>Fallback</span></slot></div></template>`;

describe.skipIf(!enabled)("public Vue converter scoped-slot fallback parity", () => {
  let directory = "";
  let liveBundle = "";
  const converted = new Map<ConversionGraph, string>();

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-vue-scoped-slot-fallback-"));
    await mkdir(join(directory, "components"));
    await writeFile(join(directory, "components", "static.html"), staticSource);
    await writeFile(join(directory, "components", "dynamic.html"), dynamicSource);
    liveBundle = join(directory, "live.js");
    await build({ entryPoints: [livePath], outfile: liveBundle, bundle: true, format: "iife", globalName: "HtmlRuntime", platform: "browser", target: ["es2022"] });

    for (const mode of ["application", "library"] as const) {
      const outDirectory = join(directory, mode);
      const manifest = await convertComponents({ mode, target: "vue", entries: ["components/static.html", "components/dynamic.html"], root: directory, outDirectory });
      assert.deepEqual(manifest.components.map((component) => component.tag).sort(), ["x-dynamic-scoped", "x-static-scoped"]);
      for (const component of manifest.components) {
        const file = join(outDirectory, component.artifact);
        const parsed = parseVue(await readFile(file, "utf8"), { filename: file });
        assert.deepEqual(parsed.errors, []);
        await writeFile(file.replace(/\.vue$/, ".ts"), compileScript(parsed.descriptor, { id: `scoped-slot-fallback-${mode}-${component.name}`, inlineTemplate: true }).content);
      }
      const entry = join(outDirectory, "entry.ts");
      const bundle = join(outDirectory, "vue.js");
      await writeFile(entry, `import { createApp, h } from "vue";
import { XStaticScoped, XDynamicScoped } from "./vue/${mode === "application" ? "application" : "index"}";
const Component = window.scopedSlotKind === "static" ? XStaticScoped : XDynamicScoped;
createApp({ render: () => h(Component, { id: "case" }) }).mount(document.querySelector("main"));
`);
      await build({
        entryPoints: [entry], outfile: bundle, bundle: true, format: "iife", platform: "browser", target: ["es2022"], nodePaths: [nodeModulesPath],
        plugins: [{ name: "compiled-vue-sfc", setup(pluginBuild) {
          pluginBuild.onResolve({ filter: /\.vue$/ }, (args) => ({ path: resolve(args.resolveDir, args.path.replace(/\.vue$/, ".ts")) }));
        } }],
      });
      converted.set(mode, bundle);
    }
  });

  afterAll(async () => { if (directory !== "") await rm(directory, { recursive: true, force: true }); });

  for (const mode of ["application", "library"] as const) {
    for (const [engine, browserType] of [["Chromium", chromium], ["Firefox", firefox], ["WebKit", webkit]] as const satisfies ReadonlyArray<readonly [string, BrowserType]>) {
      for (const kind of ["static", "dynamic"] as const) {
        it(`${engine} ${mode} renders the ${kind} scoped-slot fallback`, async () => {
          const browser = await launchParityBrowser(browserType);
          const [live, vue] = await Promise.all([browser.newPage(), browser.newPage()]);
          try {
            const tag = kind === "static" ? "x-static-scoped" : "x-dynamic-scoped";
            await live.setContent(`${staticSource}${dynamicSource}<main><${tag} id="case"></${tag}></main>`);
            await live.addScriptTag({ path: liveBundle });
            await live.evaluate(() => window.HtmlRuntime.lowerDocument());
            await vue.setContent("<main></main>");
            await vue.evaluate((value) => { window.scopedSlotKind = value; }, kind);
            await vue.addScriptTag({ path: converted.get(mode)! });
            const state = async (page: typeof live) => ({
              text: await page.locator("#case span").textContent(),
              pixels: await page.locator("#case").screenshot({ animations: "disabled" }),
            });
            const [liveState, vueState] = await Promise.all([state(live), state(vue)]);
            assert.equal(liveState.text, "Fallback");
            assert.equal(vueState.text, liveState.text);
            await assertPixelsEqual(vue, vueState.pixels, liveState.pixels, "scoped-slot fallback pixels differ");
          } finally {
            await Promise.all([live.close(), vue.close()]);
            await browser.close();
          }
        });
      }
    }
  }
});

declare global {
  interface Window {
    HtmlRuntime: { lowerDocument(): void };
    scopedSlotKind: "static" | "dynamic";
  }
}
