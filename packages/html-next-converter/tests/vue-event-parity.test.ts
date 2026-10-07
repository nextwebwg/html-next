import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";

import { compileScript, compileTemplate, parse as parseVue } from "@vue/compiler-sfc";
import { build } from "esbuild";
import { chromium, firefox, webkit, type BrowserType } from "playwright";
import { HtmlDiagnosticError } from "@nextwebwg/html-next";

import { convertComponents, type ConversionGraph } from "../src/index.js";

import { assertPixelsEqual, launchParityBrowser } from "../../html-next/tests/pixel-parity.js";
import { cases, runMatrix, snapshot, source } from "./event-modifier-cases.js";

const enabled = process.env.HTMLNEXT_TARGET_TEST === "1";
const nodeModulesPath = new URL("../../html-next/node_modules", import.meta.url).pathname;
const livePath = new URL("../../html-next/src/live.ts", import.meta.url).pathname;

describe.skipIf(!enabled)("public Vue converter event modifier matrix", () => {
  let directory = "";
  let liveBundle = "";
  const converted = new Map<ConversionGraph, { readonly fresh: string; readonly hydrate: string; readonly server: string }>();

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-vue-event-parity-"));
    await mkdir(join(directory, "components"));
    await writeFile(join(directory, "components", "matrix.html"), source);
    liveBundle = join(directory, "live.js");
    await build({ entryPoints: [livePath], outfile: liveBundle, bundle: true, format: "iife", globalName: "HtmlRuntime", platform: "browser", target: ["es2022"] });

    for (const mode of ["application", "library"] as const) {
      const outDirectory = join(directory, mode);
      const manifest = await convertComponents({ mode, target: "vue", entries: ["components/matrix.html"], root: directory, outDirectory });
      assert.deepEqual(manifest.components.map((component) => component.tag), ["x-event-matrix"]);
      const file = join(outDirectory, manifest.components[0]!.artifact);
      const parsed = parseVue(await readFile(file, "utf8"), { filename: file });
      assert.deepEqual(parsed.errors, []);
      await writeFile(file.replace(/\.vue$/, ".ts"), compileScript(parsed.descriptor, { id: `events-${mode}`, inlineTemplate: true }).content);
      const serverScript = compileScript(parsed.descriptor, { id: `events-${mode}` });
      const serverTemplate = compileTemplate({
        source: parsed.descriptor.template!.content,
        filename: file,
        id: `events-${mode}`,
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
import { XEventMatrix } from "./vue/${mode === "application" ? "application" : "index"}";
createApp({ render: () => h(XEventMatrix, { id: "case" }) }).mount(document.querySelector("main"));\n`);
      await build({
        entryPoints: [entry], outfile: bundle, bundle: true, format: "iife", platform: "browser", target: ["es2022"], nodePaths: [nodeModulesPath],
        plugins: [{ name: "compiled-vue-sfc", setup(pluginBuild) {
          pluginBuild.onResolve({ filter: /\.vue$/ }, (args) => ({ path: resolve(args.resolveDir, args.path.replace(/\.vue$/, ".ts")) }));
        } }],
      });
      const hydrateEntry = join(outDirectory, "hydrate.ts");
      const hydrate = join(outDirectory, "hydrate.js");
      await writeFile(hydrateEntry, `import { createSSRApp, h } from "vue";
import { XEventMatrix } from "./vue/${mode === "application" ? "application" : "index"}";
createSSRApp({ render: () => h(XEventMatrix, { id: "case" }) }).mount(document.querySelector("main"));\n`);
      await build({
        entryPoints: [hydrateEntry], outfile: hydrate, bundle: true, format: "iife", platform: "browser", target: ["es2022"], nodePaths: [nodeModulesPath],
        plugins: [{ name: "compiled-vue-sfc", setup(pluginBuild) {
          pluginBuild.onResolve({ filter: /\.vue$/ }, (args) => ({ path: resolve(args.resolveDir, args.path.replace(/\.vue$/, ".ts")) }));
        } }],
      });
      const serverEntry = join(outDirectory, "server.ts");
      await writeFile(serverEntry, `import { createSSRApp, h } from "vue";
import { renderToString } from "@vue/server-renderer";
import { XEventMatrix } from "./vue/${mode === "application" ? "application" : "index"}";
export const render = () => renderToString(createSSRApp({ render: () => h(XEventMatrix, { id: "case" }) }));\n`);
      const serverBuild = await build({
        entryPoints: [serverEntry], bundle: true, format: "esm", platform: "node", write: false, nodePaths: [nodeModulesPath],
        plugins: [{ name: "compiled-vue-sfc-ssr", setup(pluginBuild) {
          pluginBuild.onResolve({ filter: /\.vue$/ }, (args) => ({ path: resolve(args.resolveDir, args.path.replace(/\.vue$/, ".ssr.ts")) }));
        } }],
      });
      const serverModule = await import(`data:text/javascript;base64,${Buffer.from(serverBuild.outputFiles[0]!.text).toString("base64")}`);
      const server = await serverModule.render() as string;
      assert.match(server, /<section[^>]*id="case"/);
      converted.set(mode, { fresh: bundle, hydrate, server });
    }
  });

  afterAll(async () => { if (directory !== "") await rm(directory, { recursive: true, force: true }); });

  it("rejects invalid modifier combinations with source-located diagnostics", async () => {
    for (const [name, binding] of [
      ["passive-prevent", "on:click.passive.prevent"],
      ["repeated-stop", "on:click.stop.stop"],
      ["unknown-modifier", "on:click.unknown"],
      ["deferred-lifecycle", "on:connect"],
    ] as const) {
      const entry = `components/${name}.html`;
      await writeFile(join(directory, entry), `<template component="x-${name}" status="early" summary="Invalid event modifier."><defs><handler name="hit"></handler></defs><button ${binding}="hit">Go</button></template>`);
      await assert.rejects(
        () => convertComponents({ mode: "application", target: "vue", entries: [entry], root: directory, outDirectory: join(directory, `invalid-${name}`) }),
        (error) => error instanceof HtmlDiagnosticError && error.diagnostic.code === "HT010" &&
          error.diagnostic.source?.endsWith(entry) === true,
      );
    }
  });

  for (const mode of ["application", "library"] as const) {
    for (const [engine, browserType] of [["Chromium", chromium], ["Firefox", firefox], ["WebKit", webkit]] as const satisfies ReadonlyArray<readonly [string, BrowserType]>) {
      it(`${engine} ${mode} matches every supported modifier after mount and hydration`, async () => {
        const browser = await launchParityBrowser(browserType);
        const [live, vue, hydrated] = await Promise.all([browser.newPage(), browser.newPage(), browser.newPage()]);
        const pages = [live, vue, hydrated];
        const errors: string[] = [];
        const warnings: string[] = [];
        try {
          for (const page of pages) page.on("pageerror", (error) => errors.push(error.message));
          hydrated.on("console", (message) => { if (message.type() === "warning") warnings.push(message.text()); });
          await live.setContent(`${source}<main><x-event-matrix id="case"></x-event-matrix></main>`);
          await live.addScriptTag({ path: liveBundle });
          await live.evaluate(() => window.HtmlRuntime.lowerDocument());
          await vue.setContent("<main></main>");
          const output = converted.get(mode)!;
          await vue.addScriptTag({ path: output.fresh });
          await hydrated.setContent(`<main>${output.server}</main>`);
          const [serverLive, serverHydrated] = await Promise.all([snapshot(live), snapshot(hydrated)]);
          assert.deepEqual(serverHydrated.counts, serverLive.counts, "server-rendered event counts differ");
          await assertPixelsEqual(hydrated, serverHydrated.pixels, serverLive.pixels, "server-rendered event pixels differ");
          await hydrated.addScriptTag({ path: output.hydrate });
          const [initialLive, initialVue, initialHydrated] = await Promise.all([snapshot(live), snapshot(vue), snapshot(hydrated)]);
          assert.deepEqual(initialVue.counts, initialLive.counts);
          await assertPixelsEqual(vue, initialVue.pixels, initialLive.pixels, "event pixels differ");
          assert.deepEqual(initialHydrated.counts, initialLive.counts, "hydrated event counts differ");
          await assertPixelsEqual(hydrated, initialHydrated.pixels, initialLive.pixels, "hydrated event pixels differ");
          const [liveResults, vueResults, hydratedResults] = await Promise.all([runMatrix(live), runMatrix(vue), runMatrix(hydrated)]);
          assert.deepEqual(vueResults, liveResults, "event dispatch behavior differs");
          assert.deepEqual(hydratedResults, liveResults, "hydrated event dispatch behavior differs");
          for (const [index, scenario] of cases.entries()) {
            for (const [stepIndex, step] of scenario.steps.entries()) {
              const result = liveResults[index]![stepIndex]!;
              assert.equal(result.bubbled, step.bubbled ?? true, `${scenario.id} step ${stepIndex} propagation`);
              assert.equal(result.prevented, step.prevented ?? false, `${scenario.id} step ${stepIndex} cancellation`);
              assert.equal(result.returned, !(step.prevented ?? false), `${scenario.id} step ${stepIndex} dispatch return`);
            }
          }
          const [afterLive, afterVue, afterHydrated] = await Promise.all([snapshot(live), snapshot(vue), snapshot(hydrated)]);
          const expected = cases.map(({ steps }) => String(steps.at(-1)!.count));
          assert.deepEqual(afterLive.counts, expected, "live-runtime modifier baseline changed");
          assert.deepEqual(afterVue.counts, expected, "converted modifier counts differ");
          await assertPixelsEqual(vue, afterVue.pixels, afterLive.pixels, "converted modifier pixels differ");
          assert.deepEqual(afterHydrated.counts, expected, "hydrated modifier counts differ");
          await assertPixelsEqual(hydrated, afterHydrated.pixels, afterLive.pixels, "hydrated modifier pixels differ");
          assert.deepEqual(warnings.filter((message) => !message.startsWith("Feature flags ") && /hydration|mismatch/i.test(message)), [], "Vue reported a hydration mismatch");
          assert.deepEqual(errors, []);
        } finally {
          await Promise.all(pages.map((page) => page.close()));
          await browser.close();
        }
      });
    }
  }
});

declare global {
  interface Window { HtmlRuntime: { lowerDocument(): void } }
}
