import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";

import { compileScript, parse as parseVue } from "@vue/compiler-sfc";
import { build } from "esbuild";
import { chromium, firefox, webkit, type BrowserType } from "playwright";

import { convertComponents, type ConversionGraph } from "../src/index.js";

const enabled = process.env.HTMLNEXT_TARGET_TEST === "1";
const nodeModulesPath = new URL("../../html-next/node_modules", import.meta.url).pathname;
const loaderPath = new URL("../../html-next/src/browser-loader.ts", import.meta.url).pathname;
const source = `<template component="x-invalid-controller" status="early" summary="Invalid controller export." controller="./bad.js"><button type="button">Ready</button></template>`;
const controller = "export default 7;";

type Diagnostic = { readonly name: string; readonly code: string | null; readonly message: string; readonly source: string | null };

describe.skipIf(!enabled)("public Vue converter invalid controller module parity", () => {
  let directory = "";
  let loaderBundle = "";
  const converted = new Map<ConversionGraph, string>();

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-vue-invalid-controller-"));
    await mkdir(join(directory, "components"));
    await writeFile(join(directory, "components", "bad.html"), source);
    await writeFile(join(directory, "components", "bad.js"), controller);
    loaderBundle = join(directory, "loader.js");
    await build({ entryPoints: [loaderPath], outfile: loaderBundle, bundle: true, format: "iife", globalName: "HtmlNextLoader", platform: "browser", target: ["es2022"] });
    for (const mode of ["application", "library"] as const) {
      const outDirectory = join(directory, mode);
      const manifest = await convertComponents({
        mode, target: "vue", entries: ["components/bad.html"], root: directory, outDirectory, publicRootURL: "https://app.example/",
      });
      assert.deepEqual(manifest.components.map((component) => component.tag), ["x-invalid-controller"]);
      const file = join(outDirectory, manifest.components[0]!.artifact);
      const parsed = parseVue(await readFile(file, "utf8"), { filename: file });
      assert.deepEqual(parsed.errors, []);
      await writeFile(file.replace(/\.vue$/, ".ts"), compileScript(parsed.descriptor, { id: `invalid-controller-${mode}`, inlineTemplate: true }).content);
      const entry = join(outDirectory, "entry.ts");
      const bundle = join(outDirectory, "vue.js");
      await writeFile(entry, `import { createApp, h } from "vue";
import { XInvalidController } from "./vue/${mode === "application" ? "application" : "index"}";
const app = createApp({ render: () => h(XInvalidController, { id: "case" }) });
app.config.errorHandler = (error) => {
  window.vueControllerDiagnostic = { name: error.name, code: error.diagnostic?.code ?? null, message: error.message, source: error.diagnostic?.source ?? null };
  (window.vueControllerDiagnostics ??= []).push(window.vueControllerDiagnostic);
};
app.mount(document.querySelector("main"));
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
      it(`${engine} ${mode} preserves the root and reports HJ002`, async () => {
        const browser = await browserType.launch({ headless: true });
        const [live, vue] = await Promise.all([browser.newPage(), browser.newPage()]);
        try {
          for (const page of [live, vue]) await page.route("https://app.example/**", async (route) => {
            const url = route.request().url();
            if (url.endsWith("/components/bad.html")) await route.fulfill({ contentType: "text/html", body: source });
            else if (url.endsWith("/components/bad.js")) await route.fulfill({ contentType: "text/javascript", body: controller });
            else await route.fulfill({ contentType: "text/html", body: page === live
              ? '<link rel="component" href="/components/bad.html"><main><x-invalid-controller id="case"></x-invalid-controller></main>'
              : "<main></main>" });
          });
          await Promise.all([live.goto("https://app.example/live"), vue.goto("https://app.example/vue")]);
          await live.addScriptTag({ path: loaderBundle });
          await live.evaluate(() => (window.HtmlNextLoader as typeof window.HtmlNextLoader & {
            startBrowserComponents(root: Document, options: { onError(error: unknown): void }): Promise<unknown>;
          }).startBrowserComponents(document, {
            onError(error: unknown) {
              const value = error as Error & { diagnostic?: { code?: string; source?: string } };
              window.liveControllerDiagnostic = { name: value.name, code: value.diagnostic?.code ?? null, message: value.message, source: value.diagnostic?.source ?? null };
              (window.liveControllerDiagnostics ??= []).push(window.liveControllerDiagnostic);
            },
          }));
          await vue.addScriptTag({ path: converted.get(mode)! });
          await live.waitForFunction(() => window.liveControllerDiagnostic !== undefined);
          const expected: Diagnostic = {
            name: "HtmlDiagnosticError", code: "HJ002",
            message: "https://app.example/components/bad.html: HJ002: Controller module `https://app.example/components/bad.js` must default-export a function.",
            source: "https://app.example/components/bad.html",
          };
          assert.deepEqual(await live.evaluate(() => window.liveControllerDiagnostic), expected);
          assert.deepEqual(await vue.evaluate(() => window.vueControllerDiagnostic ?? null), expected);
          assert.equal((await live.locator("#case").textContent())?.trim(), "Ready");
          assert.equal((await vue.locator("#case").textContent())?.trim(), "Ready");
          assert.deepEqual(await vue.locator("#case").screenshot(), await live.locator("#case").screenshot());
          for (const page of [live, vue]) await page.evaluate(() => {
            window.detachedControllerRoot = document.querySelector("#case")!;
            window.detachedControllerRoot.remove();
          });
          await Promise.all([live, vue].map((page) => page.evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 0)))));
          for (const page of [live, vue]) await page.evaluate(() => document.querySelector("main")!.append(window.detachedControllerRoot));
          await live.waitForFunction(() => window.liveControllerDiagnostics?.length === 2);
          await vue.waitForFunction(() => window.vueControllerDiagnostics?.length === 2);
          assert.deepEqual(await live.evaluate(() => window.liveControllerDiagnostics), [expected, expected]);
          assert.deepEqual(await vue.evaluate(() => window.vueControllerDiagnostics), [expected, expected]);
        } finally {
          await Promise.all([live.close(), vue.close()]);
          await browser.close();
        }
      });
    }
  }
});

declare global {
  interface Window {
    HtmlNextLoader: { startBrowserComponents(): Promise<unknown> };
    liveControllerDiagnostic?: Diagnostic;
    liveControllerDiagnostics?: Diagnostic[];
    vueControllerDiagnostic?: Diagnostic;
    vueControllerDiagnostics?: Diagnostic[];
    detachedControllerRoot: Element;
  }
}
