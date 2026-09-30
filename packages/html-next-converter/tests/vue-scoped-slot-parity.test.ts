import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";

import { compileScript, compileTemplate, parse as parseVue } from "@vue/compiler-sfc";
import { build } from "esbuild";
import { chromium, firefox, webkit, type BrowserType, type Page } from "playwright";

import { convertComponents, type ConversionGraph } from "../src/index.js";

import { assertPixelsEqual, launchParityBrowser } from "../../html-next/tests/pixel-parity.js";

const enabled = process.env.HTMLNEXT_TARGET_TEST === "1";
const nodeModulesPath = new URL("../../html-next/node_modules", import.meta.url).pathname;
const livePath = new URL("../../html-next/src/live.ts", import.meta.url).pathname;
const rows = `<template component="x-scoped-rows"><defs>
  <state name="rows" :value="[{ id: 'a', name: 'Ada' }]"></state>
  <state name="alternate" :value="false"></state>
  <handler name="add"><set name="rows" :value="[{ id: 'a', name: 'Ada' }, { id: 'b', name: 'Bea' }]"></set></handler>
  <handler name="switch"><set name="alternate" :value="not alternate"></set></handler>
</defs><template $match><ol $when="alternate"><button type="button" class="add" on:click="add">Add</button><button type="button" class="switch" on:click="switch">Switch</button>
  <slot name="row" $each="row of rows" $key="row.id" from:index="loop.index"><li>Missing</li></slot></ol>
  <ul $else><button type="button" class="add" on:click="add">Add</button><button type="button" class="switch" on:click="switch">Switch</button>
  <slot name="row" $each="row of rows" $key="row.id" from:item="row" from:index="loop.index"><li>Missing</li></slot></ul>
</template></template>`;
const consumer = `<link rel="component" href="./rows.html">
<template component="x-scoped-consumer"><defs>
  <state name="item" :value="{ name: 'Parent' }"></state>
  <state name="heading" value="Team"></state>
  <handler name="rename"><set name="heading" value="Group"></set></handler>
</defs><main><button type="button" class="rename" on:click="rename">Rename</button>
  <output class="parent" $value="item.name"></output><x-scoped-rows><template slot="row">
    <li><b $value="item.name"></b><em $value="heading"></em><small $value="index"></small></li>
  </template></x-scoped-rows></main></template>`;

async function snapshot(page: Page, expected: string): Promise<{ readonly behavior: unknown; readonly pixels: Buffer }> {
  try {
    await page.waitForFunction((text) => document.querySelector("#case ul, #case ol")?.textContent?.replace(/\s/g, "") === text, expected, { timeout: 5_000 });
  } catch {
    const html = await page.evaluate(() => document.querySelector("#case")?.outerHTML);
    throw new Error(`Expected ${expected} in <ul>, got ${html}`);
  }
  await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
  return {
    behavior: await page.evaluate(() => {
      const root = document.querySelector("#case")!;
      return {
        parent: root.querySelector(".parent")?.textContent,
        listTag: root.querySelector("ul, ol")?.localName,
        rows: Array.from(root.querySelectorAll("li"), (row) => row.textContent?.replace(/\s/g, "")),
      };
    }),
    pixels: await page.locator("#case").screenshot({ animations: "disabled" }),
  };
}

describe.skipIf(!enabled)("public Vue converter scoped-slot parity", () => {
  let directory = "";
  let liveBundle = "";
  const bundles = new Map<ConversionGraph, { client: string; hydrate: string; server: string }>();

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-vue-scoped-slot-"));
    await mkdir(join(directory, "components"));
    await writeFile(join(directory, "components", "rows.html"), rows);
    await writeFile(join(directory, "components", "consumer.html"), consumer);
    liveBundle = join(directory, "live.js");
    await build({ entryPoints: [livePath], outfile: liveBundle, bundle: true, format: "iife", globalName: "HtmlRuntime", platform: "browser", target: ["es2022"] });
    for (const mode of ["application", "library"] as const) {
      const outDirectory = join(directory, mode);
      const manifest = await convertComponents({ mode, target: "vue", entries: ["components/consumer.html"], root: directory, outDirectory });
      assert.deepEqual(manifest.components.map((component) => component.tag).sort(), ["x-scoped-consumer", "x-scoped-rows"]);
      for (const component of manifest.components) {
        const file = join(outDirectory, component.artifact);
        const parsed = parseVue(await readFile(file, "utf8"), { filename: file });
        assert.deepEqual(parsed.errors, []);
        await writeFile(file.replace(/\.vue$/, ".ts"), compileScript(parsed.descriptor, { id: `scoped-${mode}-${component.name}`, inlineTemplate: true }).content);
        const serverScript = compileScript(parsed.descriptor, { id: `scoped-${mode}-${component.name}` });
        const ssrTemplate = compileTemplate({
          source: parsed.descriptor.template!.content,
          filename: file,
          id: `scoped-${mode}-${component.name}`,
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
import { XScopedConsumer } from "./vue/${mode === "application" ? "application" : "index"}";
createApp({ render: () => h(XScopedConsumer, { id: "case" }) }).mount(document.querySelector("main"));\n`);
      await build({
        entryPoints: [entry], outfile: bundle, bundle: true, format: "iife", platform: "browser", target: ["es2022"], nodePaths: [nodeModulesPath],
        plugins: [{ name: "compiled-vue-sfc", setup(pluginBuild) {
          pluginBuild.onResolve({ filter: /\.vue$/ }, (args) => ({ path: resolve(args.resolveDir, args.path.replace(/\.vue$/, ".ts")) }));
        } }],
      });
      const hydrateEntry = join(outDirectory, "hydrate.ts");
      const hydrate = join(outDirectory, "hydrate.js");
      await writeFile(hydrateEntry, `import { createSSRApp, h } from "vue";
import { XScopedConsumer } from "./vue/${mode === "application" ? "application" : "index"}";
createSSRApp({ render: () => h(XScopedConsumer, { id: "case" }) }).mount(document.querySelector("main"));
`);
      await build({
        entryPoints: [hydrateEntry], outfile: hydrate, bundle: true, format: "iife", platform: "browser", target: ["es2022"], nodePaths: [nodeModulesPath],
        plugins: [{ name: "compiled-vue-sfc", setup(pluginBuild) {
          pluginBuild.onResolve({ filter: /\.vue$/ }, (args) => ({ path: resolve(args.resolveDir, args.path.replace(/\.vue$/, ".ts")) }));
        } }],
      });
      const serverEntry = join(outDirectory, "server.ts");
      const consumerArtifact = manifest.components.find((component) => component.tag === "x-scoped-consumer")!.artifact;
      await writeFile(serverEntry, `import { createSSRApp, h } from "vue";
import { renderToString } from "@vue/server-renderer";
import XScopedConsumer from "./${consumerArtifact.replace(/\.vue$/, ".ssr")}";
export const render = () => renderToString(createSSRApp({ render: () => h(XScopedConsumer, { id: "case" }) }));
`);
      const serverBuild = await build({
        entryPoints: [serverEntry], bundle: true, format: "esm", platform: "node", write: false,
        nodePaths: [nodeModulesPath], plugins: [{ name: "compiled-vue-sfc-ssr", setup(pluginBuild) {
          pluginBuild.onResolve({ filter: /\.vue$/ }, (args) => ({ path: resolve(args.resolveDir, args.path.replace(/\.vue$/, ".ssr.ts")) }));
        } }],
      });
      const serverModule = await import(`data:text/javascript;base64,${Buffer.from(serverBuild.outputFiles[0]!.text).toString("base64")}`);
      const server = await serverModule.render() as string;
      assert.match(server, /Ada/);
      bundles.set(mode, { client: bundle, hydrate, server });
    }
  });

  afterAll(async () => { if (directory !== "") await rm(directory, { recursive: true, force: true }); });

  for (const mode of ["application", "library"] as const) {
    for (const [engine, browserType] of [["Chromium", chromium], ["Firefox", firefox], ["WebKit", webkit]] as const satisfies ReadonlyArray<readonly [string, BrowserType]>) {
      it(`${engine} ${mode} keeps lexical state and shadowed slot props`, async () => {
        const browser = await launchParityBrowser(browserType);
        const [live, vue] = await Promise.all([browser.newPage(), browser.newPage()]);
        const errors: string[] = [];
        try {
          for (const page of [live, vue]) page.on("pageerror", (error) => errors.push(error.message));
          await live.setContent(`${rows}${consumer.slice(consumer.indexOf("<template component"))}<main><x-scoped-consumer id="case"></x-scoped-consumer></main>`);
          await live.addScriptTag({ path: liveBundle });
          await live.evaluate(() => window.HtmlRuntime.lowerDocument());
          await vue.setContent("<main></main>");
          await vue.addScriptTag({ path: bundles.get(mode)!.client });
          for (const [expected, action] of [["AddSwitchAdaTeam0", null], ["AddSwitchAdaGroup0", ".rename"], ["AddSwitchAdaGroup0BeaGroup1", ".add"], ["AddSwitchParentGroup0ParentGroup1", ".switch"]] as const) {
            if (action !== null) await Promise.all([live, vue].map((page) => page.locator(`#case ${action}`).click()));
            const [actualLive, actualVue] = await Promise.all([snapshot(live, expected), snapshot(vue, expected)]);
            assert.deepEqual(actualVue.behavior, actualLive.behavior);
            await assertPixelsEqual(vue, actualVue.pixels, actualLive.pixels, "scoped-slot pixels differ");
          }
          assert.deepEqual(errors, []);
        } finally {
          await Promise.all([live.close(), vue.close()]);
          await browser.close();
        }
      });

      it(`${engine} ${mode} hydrates public scoped slots with reactive ownership intact`, async () => {
        const browser = await launchParityBrowser(browserType);
        const [serverPage, live, vue] = await Promise.all([browser.newPage(), browser.newPage(), browser.newPage()]);
        const errors: string[] = [];
        try {
          await serverPage.setContent(`${rows}${consumer.slice(consumer.indexOf("<template component"))}<main><x-scoped-consumer id="case"></x-scoped-consumer></main>`);
          await serverPage.addScriptTag({ path: liveBundle });
          const liveServer = await serverPage.evaluate(() => {
            window.HtmlRuntime.lowerDocument();
            return (window.HtmlRuntime as typeof window.HtmlRuntime & { serializeRenderedForm(container: Element): string })
              .serializeRenderedForm(document.querySelector("main")!);
          });
          for (const page of [live, vue]) page.on("pageerror", (error) => errors.push(error.message));
          await live.setContent(`${rows}${consumer.slice(consumer.indexOf("<template component"))}${liveServer}`);
          await vue.setContent(`<main>${bundles.get(mode)!.server}</main>`);
          const [serverLive, serverVue] = await Promise.all([snapshot(live, "AddSwitchAdaTeam0"), snapshot(vue, "AddSwitchAdaTeam0")]);
          assert.deepEqual(serverVue.behavior, serverLive.behavior, "server-rendered scoped-slot behavior differs");
          await assertPixelsEqual(vue, serverVue.pixels, serverLive.pixels, "server-rendered scoped-slot pixels differ");
          for (const page of [live, vue]) await page.evaluate(() => {
            window.scopedHydrationRoot = document.querySelector("#case")!;
            window.scopedHydrationRow = window.scopedHydrationRoot.querySelector("li")!;
          });
          await live.addScriptTag({ path: liveBundle });
          await live.evaluate(() => window.HtmlRuntime.lowerDocument());
          await vue.addScriptTag({ path: bundles.get(mode)!.hydrate });
          for (const page of [live, vue]) {
            const retained = await page.evaluate(() => ({
              root: document.querySelector("#case") === window.scopedHydrationRoot,
              row: document.querySelector("#case li") === window.scopedHydrationRow,
            }));
            assert.deepEqual(retained, { root: true, row: true }, page === live ? "HTML Next hydration replaced nodes" : "Vue hydration replaced nodes");
          }
          for (const [expected, action] of [["AddSwitchAdaTeam0", null], ["AddSwitchAdaGroup0", ".rename"], ["AddSwitchAdaGroup0BeaGroup1", ".add"], ["AddSwitchParentGroup0ParentGroup1", ".switch"]] as const) {
            if (action !== null) await Promise.all([live, vue].map((page) => page.locator(`#case ${action}`).click()));
            const [actualLive, actualVue] = await Promise.all([snapshot(live, expected), snapshot(vue, expected)]);
            assert.deepEqual(actualVue.behavior, actualLive.behavior);
            await assertPixelsEqual(vue, actualVue.pixels, actualLive.pixels, "scoped-slot pixels differ");
          }
          assert.deepEqual(errors, []);
        } finally {
          await Promise.all([serverPage.close(), live.close(), vue.close()]);
          await browser.close();
        }
      });
    }
  }
});

declare global {
  interface Window {
    scopedHydrationRoot: Element;
    scopedHydrationRow: Element;
  }
}
