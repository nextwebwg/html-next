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
const livePath = new URL("../../html-next/src/live.ts", import.meta.url).pathname;
const staticSource = `<template component="x-hydration-static" status="early" summary="Fixed-root hydration diagnostic."><button type="button">Ready</button></template>`;
const switchSource = `<template component="x-hydration-switch" status="early" summary="Conditional-root hydration diagnostic."><defs>
  <state name="alternate" :value="false"></state>
</defs><template $match><article $when="alternate">Alternate</article><section $else>Initial</section></template></template>`;

type Diagnostic = { readonly name: string; readonly code: string | null; readonly message: string };

describe.skipIf(!enabled)("public Vue converter hydration-root diagnostic parity", () => {
  let directory = "";
  let liveBundle = "";
  const converted = new Map<ConversionGraph, string>();

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-vue-hydration-diagnostic-"));
    await mkdir(join(directory, "components"));
    await writeFile(join(directory, "components", "static.html"), staticSource);
    await writeFile(join(directory, "components", "switch.html"), switchSource);
    liveBundle = join(directory, "live.js");
    await build({ entryPoints: [livePath], outfile: liveBundle, bundle: true, format: "iife", globalName: "HtmlRuntime", platform: "browser", target: ["es2022"] });

    for (const mode of ["application", "library"] as const) {
      const outDirectory = join(directory, mode);
      const manifest = await convertComponents({
        mode, target: "vue", entries: ["components/static.html", "components/switch.html"], root: directory, outDirectory,
      });
      assert.deepEqual(manifest.components.map((component) => component.tag).sort(), ["x-hydration-static", "x-hydration-switch"]);
      for (const component of manifest.components) {
        const file = join(outDirectory, component.artifact);
        const parsed = parseVue(await readFile(file, "utf8"), { filename: file });
        assert.deepEqual(parsed.errors, []);
        await writeFile(file.replace(/\.vue$/, ".ts"), compileScript(parsed.descriptor, { id: `hydration-diagnostic-${mode}-${component.name}`, inlineTemplate: true }).content);
      }
      const entry = join(outDirectory, "entry.ts");
      const bundle = join(outDirectory, "vue.js");
      await writeFile(entry, `import { createSSRApp, h } from "vue";
import { XHydrationStatic, XHydrationSwitch } from "./vue/${mode === "application" ? "application" : "index"}";
const Component = window.hydrationKind === "static" ? XHydrationStatic : XHydrationSwitch;
const app = createSSRApp({ render: () => h(Component, { id: "case" }) });
app.config.errorHandler = (error) => {
  window.vueHydrationDiagnostic = { name: error.name, code: error.diagnostic?.code ?? null, message: error.message };
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
      for (const kind of ["static", "switch"] as const) {
        it(`${engine} ${mode} reports HR005 for an incompatible ${kind} root`, async () => {
          const browser = await browserType.launch({ headless: true });
          const [live, vue] = await Promise.all([browser.newPage(), browser.newPage()]);
          try {
            const tag = kind === "static" ? "x-hydration-static" : "x-hydration-switch";
            const serverRoot = kind === "static" ? "div" : "article";
            const markup = `<main><${serverRoot} id="case" data-component="${tag}">Wrong server root</${serverRoot}></main>`;
            await live.setContent(`${staticSource}${switchSource}${markup}`);
            await live.addScriptTag({ path: liveBundle });
            const liveDiagnostic = await live.evaluate((): Diagnostic | null => {
              try { window.HtmlRuntime.lowerDocument(); return null; }
              catch (error) {
                const value = error as Error & { diagnostic?: { code?: string } };
                return { name: value.name, code: value.diagnostic?.code ?? null, message: value.message };
              }
            });
            await vue.setContent(markup);
            await vue.evaluate((value) => { window.hydrationKind = value; }, kind);
            await vue.addScriptTag({ path: converted.get(mode)! });
            const vueDiagnostic = await vue.evaluate(() => window.vueHydrationDiagnostic ?? null);
            assert.deepEqual(liveDiagnostic, {
              name: "HtmlDiagnosticError", code: "HR005",
              message: `HR005: Server markup for <${tag}> has an incompatible root.`,
            });
            assert.deepEqual(vueDiagnostic, liveDiagnostic);
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
    hydrationKind: "static" | "switch";
    vueHydrationDiagnostic?: Diagnostic;
  }
}
