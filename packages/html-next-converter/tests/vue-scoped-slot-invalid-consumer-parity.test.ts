import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";

import { compileScript, compileTemplate, parse as parseVue } from "@vue/compiler-sfc";
import { build } from "esbuild";
import { chromium, firefox, webkit, type BrowserType } from "playwright";

import { convertComponents, type ConversionGraph } from "../src/index.js";

const enabled = process.env.HTMLNEXT_TARGET_TEST === "1";
const nodeModulesPath = new URL("../../html-next/node_modules", import.meta.url).pathname;
const livePath = new URL("../../html-next/src/live.ts", import.meta.url).pathname;
const receiver = `<template component="x-scoped-receiver" status="early" summary="Scoped slot receiver."><div><slot name="row" :item="'Ada'"><span>Fallback</span></slot></div></template>`;
const consumer = `<link rel="component" href="./receiver.html"><template component="x-invalid-scoped-consumer" status="early" summary="Invalid scoped slot consumer."><main><x-scoped-receiver><span slot="row">Not a template</span></x-scoped-receiver></main></template>`;
const dynamicReceiver = `<template component="x-dynamic-scoped-receiver" status="early" summary="Dynamic scoped slot receiver."><defs><state name="slotName" value="row"></state></defs><div><slot :name="slotName" :item="'Ada'"><span>Fallback</span></slot></div></template>`;
const dynamicConsumer = `<link rel="component" href="./dynamic-receiver.html"><template component="x-invalid-dynamic-scoped-consumer" status="early" summary="Invalid dynamic scoped slot consumer."><main><x-dynamic-scoped-receiver><span slot="row">Not a template</span></x-dynamic-scoped-receiver></main></template>`;

type Diagnostic = { readonly name: string; readonly code: string | null; readonly message: string };

describe.skipIf(!enabled)("public Vue converter invalid scoped-slot consumer parity", () => {
  let directory = "";
  let liveBundle = "";
  const converted = new Map<ConversionGraph, string>();
  const serverRenders = new Map<ConversionGraph, (kind: "static" | "dynamic") => Promise<string>>();

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-vue-invalid-scoped-slot-"));
    await mkdir(join(directory, "components"));
    await writeFile(join(directory, "components", "receiver.html"), receiver);
    await writeFile(join(directory, "components", "consumer.html"), consumer);
    await writeFile(join(directory, "components", "dynamic-receiver.html"), dynamicReceiver);
    await writeFile(join(directory, "components", "dynamic-consumer.html"), dynamicConsumer);
    liveBundle = join(directory, "live.js");
    await build({ entryPoints: [livePath], outfile: liveBundle, bundle: true, format: "iife", globalName: "HtmlRuntime", platform: "browser", target: ["es2022"] });

    for (const mode of ["application", "library"] as const) {
      const outDirectory = join(directory, mode);
      const manifest = await convertComponents({ mode, target: "vue", entries: ["components/consumer.html", "components/dynamic-consumer.html"], root: directory, outDirectory });
      assert.deepEqual(manifest.components.map((component) => component.tag).sort(), [
        "x-dynamic-scoped-receiver", "x-invalid-dynamic-scoped-consumer", "x-invalid-scoped-consumer", "x-scoped-receiver",
      ]);
      for (const component of manifest.components) {
        const file = join(outDirectory, component.artifact);
        const parsed = parseVue(await readFile(file, "utf8"), { filename: file });
        assert.deepEqual(parsed.errors, []);
        await writeFile(file.replace(/\.vue$/, ".ts"), compileScript(parsed.descriptor, { id: `invalid-scoped-slot-${mode}-${component.name}`, inlineTemplate: true }).content);
        const serverScript = compileScript(parsed.descriptor, { id: `invalid-scoped-slot-${mode}-${component.name}` });
        const ssrTemplate = compileTemplate({
          source: parsed.descriptor.template!.content,
          filename: file,
          id: `invalid-scoped-slot-${mode}-${component.name}`,
          ssr: true,
          ssrCssVars: [],
          compilerOptions: { bindingMetadata: serverScript.bindings ?? {} },
        });
        assert.deepEqual(ssrTemplate.errors, []);
        await writeFile(file.replace(/\.vue$/, ".ssr.ts"), `${serverScript.content.replace("export default", "const Component =")}
${ssrTemplate.code}
export default Object.assign(Component, { ssrRender });
`);
      }
      const entry = join(outDirectory, "entry.ts");
      const bundle = join(outDirectory, "vue.js");
      await writeFile(entry, `import { createApp, h } from "vue";
import { XInvalidScopedConsumer, XInvalidDynamicScopedConsumer } from "./vue/${mode === "application" ? "application" : "index"}";
const Component = window.scopedSlotKind === "dynamic" ? XInvalidDynamicScopedConsumer : XInvalidScopedConsumer;
const app = createApp({ render: () => h(Component, { id: "case" }) });
app.config.errorHandler = (error) => {
  window.vueScopedSlotDiagnostic = { name: error.name, code: error.diagnostic?.code ?? null, message: error.message };
};
app.mount(document.querySelector("#mount"));
`);
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
import { XInvalidScopedConsumer, XInvalidDynamicScopedConsumer } from "./vue/${mode === "application" ? "application" : "index"}";
export const render = (kind) => renderToString(createSSRApp({ render: () => h(kind === "dynamic" ? XInvalidDynamicScopedConsumer : XInvalidScopedConsumer, { id: "case" }) }));
`);
      const serverBuild = await build({
        entryPoints: [serverEntry], bundle: true, format: "esm", platform: "node", write: false, nodePaths: [nodeModulesPath],
        plugins: [{ name: "compiled-vue-sfc-ssr", setup(pluginBuild) {
          pluginBuild.onResolve({ filter: /\.vue$/ }, (args) => ({ path: resolve(args.resolveDir, args.path.replace(/\.vue$/, ".ssr.ts")) }));
        } }],
      });
      const serverModule = await import(`data:text/javascript;base64,${Buffer.from(serverBuild.outputFiles[0]!.text).toString("base64")}`);
      serverRenders.set(mode, serverModule.render as (kind: "static" | "dynamic") => Promise<string>);
    }
  });

  afterAll(async () => { if (directory !== "") await rm(directory, { recursive: true, force: true }); });

  for (const mode of ["application", "library"] as const) {
    for (const kind of ["static", "dynamic"] as const) {
      it(`${mode} SSR reports HR007 for an ordinary ${kind} scoped-slot child`, async () => {
        await assert.rejects(serverRenders.get(mode)!(kind), (error) => {
          const failure = error as Error & { diagnostic?: { code?: string } };
          assert.deepEqual({ name: failure.name, code: failure.diagnostic?.code ?? null, message: failure.message }, {
            name: "HtmlDiagnosticError", code: "HR007",
            message: 'HR007: Scoped slot `row` requires a consumer <template slot="row">.',
          });
          return true;
        });
      });
    }
    for (const [engine, browserType] of [["Chromium", chromium], ["Firefox", firefox], ["WebKit", webkit]] as const satisfies ReadonlyArray<readonly [string, BrowserType]>) {
      for (const kind of ["static", "dynamic"] as const) {
        it(`${engine} ${mode} reports HR007 for an ordinary ${kind} scoped-slot child`, async () => {
          const browser = await browserType.launch({ headless: true });
          const [live, vue] = await Promise.all([browser.newPage(), browser.newPage()]);
          try {
            const tag = kind === "static" ? "x-invalid-scoped-consumer" : "x-invalid-dynamic-scoped-consumer";
            await live.setContent(`${receiver}${consumer}${dynamicReceiver}${dynamicConsumer}<${tag} id="case"></${tag}>`);
            await live.addScriptTag({ path: liveBundle });
            const liveDiagnostic = await live.evaluate((): Diagnostic | null => {
              try { window.HtmlRuntime.lowerDocument(); return null; }
              catch (error) {
                const value = error as Error & { diagnostic?: { code?: string } };
                return { name: value.name, code: value.diagnostic?.code ?? null, message: value.message };
              }
            });
            await vue.setContent("<div id=mount></div>");
            await vue.evaluate((value) => { window.scopedSlotKind = value; }, kind);
            await vue.addScriptTag({ path: converted.get(mode)! });
            const vueDiagnostic = await vue.evaluate(() => window.vueScopedSlotDiagnostic ?? null);
            assert.deepEqual(liveDiagnostic, {
              name: "HtmlDiagnosticError", code: "HR007",
              message: 'HR007: Scoped slot `row` requires a consumer <template slot="row">.',
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
    scopedSlotKind: "static" | "dynamic";
    vueScopedSlotDiagnostic?: Diagnostic;
  }
}
