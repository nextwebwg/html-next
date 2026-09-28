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
const source = `<template component="x-context-reader" status="early" summary="Context reader."><defs>
  <context name="current" from="x-steps"></context>
</defs><span $value="current"></span></template>`;

type Diagnostic = { readonly name: string; readonly code: string | null; readonly message: string };

describe.skipIf(!enabled)("public Vue converter missing-context diagnostic parity", () => {
  let directory = "";
  let liveBundle = "";
  const converted = new Map<ConversionGraph, string>();

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-vue-context-diagnostic-"));
    await mkdir(join(directory, "components"));
    await writeFile(join(directory, "components", "reader.html"), source);
    liveBundle = join(directory, "live.js");
    await build({ entryPoints: [livePath], outfile: liveBundle, bundle: true, format: "iife", globalName: "HtmlRuntime", platform: "browser", target: ["es2022"] });

    for (const mode of ["application", "library"] as const) {
      const outDirectory = join(directory, mode);
      const manifest = await convertComponents({ mode, target: "vue", entries: ["components/reader.html"], root: directory, outDirectory });
      assert.deepEqual(manifest.components.map((component) => component.tag), ["x-context-reader"]);
      const file = join(outDirectory, manifest.components[0]!.artifact);
      const parsed = parseVue(await readFile(file, "utf8"), { filename: file });
      assert.deepEqual(parsed.errors, []);
      await writeFile(file.replace(/\.vue$/, ".ts"), compileScript(parsed.descriptor, { id: `context-diagnostic-${mode}`, inlineTemplate: true }).content);
      const entry = join(outDirectory, "entry.ts");
      const bundle = join(outDirectory, "vue.js");
      await writeFile(entry, `import { createApp, h } from "vue";
import { XContextReader } from "./vue/${mode === "application" ? "application" : "index"}";
const app = createApp({ render: () => h(XContextReader, { id: "case" }) });
app.config.errorHandler = (error) => {
  window.vueContextDiagnostic = { name: error.name, code: error.diagnostic?.code ?? null, message: error.message };
};
app.mount(document.querySelector("main"));\n`);
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
      it(`${engine} ${mode} reports HR009 when the logical provider is absent`, async () => {
        const browser = await browserType.launch({ headless: true });
        const [live, vue] = await Promise.all([browser.newPage(), browser.newPage()]);
        try {
          await live.setContent(`${source}<main><x-context-reader id="case"></x-context-reader></main>`);
          await live.addScriptTag({ path: liveBundle });
          const liveDiagnostic = await live.evaluate((): Diagnostic | null => {
            try { window.HtmlRuntime.lowerDocument(); return null; }
            catch (error) {
              const value = error as Error & { diagnostic?: { code?: string } };
              return { name: value.name, code: value.diagnostic?.code ?? null, message: value.message };
            }
          });
          await vue.setContent("<main></main>");
          await vue.addScriptTag({ path: converted.get(mode)! });
          const vueDiagnostic = await vue.evaluate(() => window.vueContextDiagnostic ?? null);
          assert.deepEqual(liveDiagnostic, {
            name: "HtmlDiagnosticError", code: "HR009",
            message: "HR009: <x-context-reader> requires context `current` from <x-steps>.",
          });
          assert.deepEqual(vueDiagnostic, liveDiagnostic);
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
    HtmlRuntime: { lowerDocument(): void };
    vueContextDiagnostic?: Diagnostic;
  }
}
