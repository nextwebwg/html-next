import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";

import { compileScript, compileTemplate, parse as parseVue } from "@vue/compiler-sfc";
import { build } from "esbuild";
import { chromium, firefox, webkit, type BrowserType, type Page } from "playwright";

import { convertComponents, type ConversionGraph } from "../src/index.js";

const enabled = process.env.HTMLNEXT_TARGET_TEST === "1";
const nodeModulesPath = new URL("../../html-next/node_modules", import.meta.url).pathname;
const livePath = new URL("../../html-next/src/live.ts", import.meta.url).pathname;
const source = `<template component="x-depth" status="early" summary="Bounded recursive component."><defs>
  <prop name="level" type="number" default="0">Current depth.</prop>
</defs><section><span $value="level"></span><x-depth $if="level < 33" :level="level + 1"></x-depth></section></template>`;

type Diagnostic = { readonly name: string; readonly code: string | null; readonly message: string };

describe.skipIf(!enabled)("public Vue converter recursive lowering parity", () => {
  let directory = "";
  let liveBundle = "";
  const converted = new Map<ConversionGraph, string>();
  const serverRenders = new Map<ConversionGraph, (level: number) => Promise<string>>();

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-vue-recursion-parity-"));
    await mkdir(join(directory, "components"));
    await writeFile(join(directory, "components", "depth.html"), source);
    liveBundle = join(directory, "live.js");
    await build({ entryPoints: [livePath], outfile: liveBundle, bundle: true, format: "iife", globalName: "HtmlRuntime", platform: "browser", target: ["es2022"] });

    for (const mode of ["application", "library"] as const) {
      const outDirectory = join(directory, mode);
      const manifest = await convertComponents({ mode, target: "vue", entries: ["components/depth.html"], root: directory, outDirectory });
      assert.deepEqual(manifest.components.map((component) => component.tag), ["x-depth"]);
      const file = join(outDirectory, manifest.components[0]!.artifact);
      const parsed = parseVue(await readFile(file, "utf8"), { filename: file });
      assert.deepEqual(parsed.errors, []);
      await writeFile(file.replace(/\.vue$/, ".ts"), compileScript(parsed.descriptor, { id: `recursion-${mode}`, inlineTemplate: true }).content);
      const serverScript = compileScript(parsed.descriptor, { id: `recursion-${mode}` });
      const serverTemplate = compileTemplate({
        source: parsed.descriptor.template!.content,
        filename: file,
        id: `recursion-${mode}`,
        ssr: true,
        ssrCssVars: [],
        compilerOptions: { bindingMetadata: serverScript.bindings ?? {} },
      });
      assert.deepEqual(serverTemplate.errors, []);
      await writeFile(file.replace(/\.vue$/, ".ssr.ts"), `${serverScript.content.replace("export default", "const Component =")}
${serverTemplate.code}
export default Object.assign(Component, { ssrRender });
`);
      const entry = join(outDirectory, "entry.ts");
      const bundle = join(outDirectory, "vue.js");
      await writeFile(entry, `import { createApp, h } from "vue";
import { XDepth } from "./vue/${mode === "application" ? "application" : "index"}";
const app = createApp({ render: () => h(XDepth, { id: "case", level: window.initialLevel }) });
app.config.errorHandler = (error) => {
  window.vueRecursionDiagnostic = { name: error.name, code: error.diagnostic?.code ?? null, message: error.message };
};
app.mount(document.querySelector("main"));\n`);
      await build({
        entryPoints: [entry], outfile: bundle, bundle: true, format: "iife", platform: "browser", target: ["es2022"], nodePaths: [nodeModulesPath],
        plugins: [{ name: "compiled-vue-sfc", setup(pluginBuild) {
          pluginBuild.onResolve({ filter: /\.vue$/ }, (args) => ({ path: resolve(args.resolveDir, args.path.replace(/\.vue$/, ".ts")) }));
        } }],
      });
      converted.set(mode, bundle);
      const serverEntry = join(outDirectory, "server.ts");
      await writeFile(serverEntry, `import { createSSRApp, h } from "vue";
import { renderToString } from "@vue/server-renderer";
import { XDepth } from "./vue/${mode === "application" ? "application" : "index"}";
export const render = (level) => renderToString(createSSRApp({ render: () => h(XDepth, { id: "case", level }) }));
`);
      const serverBuild = await build({
        entryPoints: [serverEntry], bundle: true, format: "esm", platform: "node", write: false, nodePaths: [nodeModulesPath],
        plugins: [{ name: "compiled-vue-sfc-ssr", setup(pluginBuild) {
          pluginBuild.onResolve({ filter: /\.vue$/ }, (args) => ({ path: resolve(args.resolveDir, args.path.replace(/\.vue$/, ".ssr.ts")) }));
        } }],
      });
      const serverModule = await import(`data:text/javascript;base64,${Buffer.from(serverBuild.outputFiles[0]!.text).toString("base64")}`);
      serverRenders.set(mode, serverModule.render as (level: number) => Promise<string>);
    }
  });

  afterAll(async () => { if (directory !== "") await rm(directory, { recursive: true, force: true }); });

  for (const mode of ["application", "library"] as const) {
    it(`${mode} SSR retains the recursive lowering boundary`, async () => {
      const rendered = await serverRenders.get(mode)!(2);
      assert.deepEqual([...rendered.matchAll(/<span>(\d+)<\/span>/g)].map((match) => match[1]),
        Array.from({ length: 32 }, (_, index) => String(index + 2)));
      await assert.rejects(serverRenders.get(mode)!(1), (error) => {
        const value = error as Error & { diagnostic?: { code?: string } };
        assert.deepEqual({ name: value.name, code: value.diagnostic?.code ?? null, message: value.message }, {
          name: "HtmlDiagnosticError", code: "HR008", message: "HR008: Component invocations nested deeper than the lowering limit.",
        });
        return true;
      });
    });
    for (const [engine, browserType] of [["Chromium", chromium], ["Firefox", firefox], ["WebKit", webkit]] as const satisfies ReadonlyArray<readonly [string, BrowserType]>) {
      for (const level of [31, 2, 1, 0] as const) {
        it(`${engine} ${mode} ${level <= 1 ? `reports HR008 from level ${level}` : `renders recursion from level ${level}`}`, async () => {
          const browser = await browserType.launch({ headless: true });
          const [live, vue] = await Promise.all([browser.newPage(), browser.newPage()]);
          try {
            await live.setContent(`${source}<main><x-depth id="case" level="${level}"></x-depth></main>`);
            await live.addScriptTag({ path: liveBundle });
            const liveDiagnostic = await live.evaluate((): Diagnostic | null => {
              try { window.HtmlRuntime.lowerDocument(); return null; }
              catch (error) {
                const value = error as Error & { diagnostic?: { code?: string } };
                return { name: value.name, code: value.diagnostic?.code ?? null, message: value.message };
              }
            });
            await vue.setContent("<main></main>");
            await vue.evaluate((value) => { window.initialLevel = value; }, level);
            await vue.addScriptTag({ path: converted.get(mode)! });
            const vueDiagnostic = await vue.evaluate(() => window.vueRecursionDiagnostic ?? null);
            assert.deepEqual(vueDiagnostic, liveDiagnostic, "recursive lowering diagnostic differs");
            if (level > 1) {
              assert.equal(liveDiagnostic, null);
              const text = async (page: Page) => page.locator("#case span").allTextContents();
              assert.deepEqual(await text(live), Array.from({ length: 34 - level }, (_, index) => String(level + index)));
              assert.deepEqual(await text(vue), await text(live));
              assert.deepEqual(await vue.locator("#case").screenshot(), await live.locator("#case").screenshot());
            } else {
              assert.deepEqual(liveDiagnostic, {
                name: "HtmlDiagnosticError", code: "HR008", message: "HR008: Component invocations nested deeper than the lowering limit.",
              });
            }
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
    initialLevel: number;
    vueRecursionDiagnostic?: Diagnostic;
  }
}
