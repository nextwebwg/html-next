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
const panelBody = `<button type="button" class="expand" on:click="expand">Expand</button>
  <button type="button" class="switch" on:click="switchRoot">Switch</button>
  <header><slot name="title"><h2>Untitled</h2></slot></header>
  <main><slot><p>Empty</p></slot></main>
  <ul><li $each="row of rows" $key="row"><slot from:name="concat('row-', row)"><span class="missing">Missing</span></slot></li></ul>
  <div class="extra" $if="open"><slot name="extra"><em>Extra fallback</em></slot></div>`;
const source = `<template component="x-slot-panel" status="early" summary="Slot parity."><defs>
  <state name="branch" type="keyword" value="section"></state>
  <state type="list(unknown)" name="rows" value="['a']"></state>
  <state type="boolean" name="open" value="false"></state>
  <handler name="expand"><set name="rows" expr:value="['a', 'b']"></set><set name="open" value="true"></set></handler>
  <handler name="switchRoot"><set name="branch" expr:value="'article'"></set></handler>
</defs><template $match><article $when="branch = 'article'">${panelBody}</article><section $else>${panelBody}</section></template></template>`;
const invocation = `<x-slot-panel id="case"><h2 id="title-node" slot="title">Title</h2>
  <p id="body-node">Body</p><strong id="row-a" slot="row-a">A</strong>
  <b id="row-b" slot="row-b">B</b></x-slot-panel>`;

type Behavior = {
  readonly root: string;
  readonly title: string | null;
  readonly body: string | null;
  readonly rows: readonly string[];
  readonly extra: string | null;
};

async function snapshot(page: Page, tag: string, rowCount: number): Promise<{ readonly behavior: Behavior; readonly pixels: Buffer }> {
  await page.waitForFunction(([expectedTag, expectedRows]) => {
    const root = document.querySelector("#case");
    return root !== null && root.localName === expectedTag && root.querySelectorAll("li").length === expectedRows;
  }, [tag, rowCount]);
  await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
  return {
    behavior: await page.evaluate(() => {
      const root = document.querySelector("#case")!;
      return {
        root: root.localName,
        title: root.querySelector("header")?.textContent?.trim() ?? null,
        body: root.querySelector("main")?.textContent?.trim() ?? null,
        rows: Array.from(root.querySelectorAll("li"), (row) => row.textContent!.trim()),
        extra: root.querySelector(".extra")?.textContent?.trim() ?? null,
      };
    }),
    pixels: await page.locator("#case").screenshot({ animations: "disabled" }),
  };
}

describe.skipIf(!enabled)("public Vue converter slot parity", () => {
  let directory = "";
  let liveBundle = "";
  const converted = new Map<ConversionGraph, { readonly fresh: string; readonly hydrate: string; readonly server: string }>();

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-vue-slot-parity-"));
    await mkdir(join(directory, "components"));
    await writeFile(join(directory, "components", "panel.html"), source);
    liveBundle = join(directory, "live.js");
    await build({ entryPoints: [livePath], outfile: liveBundle, bundle: true, format: "iife", globalName: "HtmlRuntime", platform: "browser", target: ["es2022"] });

    for (const mode of ["application", "library"] as const) {
      const outDirectory = join(directory, mode);
      const manifest = await convertComponents({ mode, target: "vue", entries: ["components/panel.html"], root: directory, outDirectory });
      assert.deepEqual(manifest.components.map((component) => component.tag), ["x-slot-panel"]);
      assert.equal(manifest.output.entry, `vue/${mode === "application" ? "application" : "index"}.ts`);
      const file = join(outDirectory, manifest.components[0]!.artifact);
      const parsed = parseVue(await readFile(file, "utf8"), { filename: file });
      assert.deepEqual(parsed.errors, []);
      await writeFile(file.replace(/\.vue$/, ".ts"), compileScript(parsed.descriptor, { id: `slots-${mode}`, inlineTemplate: true }).content);
      const serverScript = compileScript(parsed.descriptor, { id: `slots-${mode}` });
      const serverTemplate = compileTemplate({
        source: parsed.descriptor.template!.content,
        filename: file,
        id: `slots-${mode}`,
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
import { XSlotPanel } from "./vue/${mode === "application" ? "application" : "index"}";
const slots = {
  title: () => h("h2", { id: "title-node" }, "Title"),
  default: () => h("p", { id: "body-node" }, "Body"),
  "row-a": () => h("strong", { id: "row-a" }, "A"),
  "row-b": () => h("b", { id: "row-b" }, "B"),
};
createApp({ render: () => h(XSlotPanel, { id: "case" }, slots) }).mount(document.querySelector("main"));\n`);
      await build({
        entryPoints: [entry], outfile: bundle, bundle: true, format: "iife", platform: "browser", target: ["es2022"], nodePaths: [nodeModulesPath],
        plugins: [{ name: "compiled-vue-sfc", setup(pluginBuild) {
          pluginBuild.onResolve({ filter: /\.vue$/ }, (args) => ({ path: resolve(args.resolveDir, args.path.replace(/\.vue$/, ".ts")) }));
        } }],
      });
      const hydrateEntry = join(outDirectory, "hydrate.ts");
      const hydrate = join(outDirectory, "hydrate.js");
      await writeFile(hydrateEntry, `import { createSSRApp, h } from "vue";
import { XSlotPanel } from "./vue/${mode === "application" ? "application" : "index"}";
const slots = {
  title: () => h("h2", { id: "title-node" }, "Title"),
  default: () => h("p", { id: "body-node" }, "Body"),
  "row-a": () => h("strong", { id: "row-a" }, "A"),
  "row-b": () => h("b", { id: "row-b" }, "B"),
};
createSSRApp({ render: () => h(XSlotPanel, { id: "case" }, slots) }).mount(document.querySelector("main"));\n`);
      await build({
        entryPoints: [hydrateEntry], outfile: hydrate, bundle: true, format: "iife", platform: "browser", target: ["es2022"], nodePaths: [nodeModulesPath],
        plugins: [{ name: "compiled-vue-sfc", setup(pluginBuild) {
          pluginBuild.onResolve({ filter: /\.vue$/ }, (args) => ({ path: resolve(args.resolveDir, args.path.replace(/\.vue$/, ".ts")) }));
        } }],
      });
      const serverEntry = join(outDirectory, "server.ts");
      await writeFile(serverEntry, `import { createSSRApp, h } from "vue";
import { renderToString } from "@vue/server-renderer";
import { XSlotPanel } from "./vue/${mode === "application" ? "application" : "index"}";
const slots = {
  title: () => h("h2", { id: "title-node" }, "Title"),
  default: () => h("p", { id: "body-node" }, "Body"),
  "row-a": () => h("strong", { id: "row-a" }, "A"),
  "row-b": () => h("b", { id: "row-b" }, "B"),
};
export const render = () => renderToString(createSSRApp({ render: () => h(XSlotPanel, { id: "case" }, slots) }));\n`);
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

  for (const mode of ["application", "library"] as const) {
    for (const [engine, browserType] of [["Chromium", chromium], ["Firefox", firefox], ["WebKit", webkit]] as const satisfies ReadonlyArray<readonly [string, BrowserType]>) {
      for (const switchRoot of [false, true] as const) {
      it(`${engine} ${mode} ${switchRoot ? "matches hydrated slots across a root switch" : "matches hydrated named, dynamic, and fallback slots"}`, async () => {
        const browser = await launchParityBrowser(browserType);
        const [live, vue, hydrated] = await Promise.all([browser.newPage(), browser.newPage(), browser.newPage()]);
        const pages = [live, vue, hydrated];
        const errors: string[] = [];
        const warnings: string[] = [];
        try {
          for (const page of pages) page.on("pageerror", (error) => errors.push(error.message));
          hydrated.on("console", (message) => { if (message.type() === "warning") warnings.push(message.text()); });
          await live.setContent(`${source}<main>${invocation}</main>`);
          await live.addScriptTag({ path: liveBundle });
          await live.evaluate(() => window.HtmlRuntime.lowerDocument());
          await vue.setContent("<main></main>");
          const output = converted.get(mode)!;
          await vue.addScriptTag({ path: output.fresh });
          await hydrated.setContent(`<main>${output.server}</main>`);
          const [serverLive, serverHydrated] = await Promise.all([snapshot(live, "section", 1), snapshot(hydrated, "section", 1)]);
          assert.deepEqual(serverHydrated.behavior, serverLive.behavior, "server-rendered slot behavior differs");
          await assertPixelsEqual(hydrated, serverHydrated.pixels, serverLive.pixels, "server-rendered slot pixels differ");
          await hydrated.addScriptTag({ path: output.hydrate });
          const compare = async (stage: string, tag: string, rows: number) => {
            const [actualLive, actualVue, actualHydrated] = await Promise.all([snapshot(live, tag, rows), snapshot(vue, tag, rows), snapshot(hydrated, tag, rows)]);
            assert.deepEqual(actualVue.behavior, actualLive.behavior, `${stage} slot behavior differs`);
            await assertPixelsEqual(vue, actualVue.pixels, actualLive.pixels, `${stage} slot pixels differ`);
            assert.deepEqual(actualHydrated.behavior, actualLive.behavior, `${stage} hydrated slot behavior differs`);
            await assertPixelsEqual(hydrated, actualHydrated.pixels, actualLive.pixels, `${stage} hydrated slot pixels differ`);
            return actualLive.behavior;
          };
          const initial = await compare("initial", "section", 1);
          assert.deepEqual(initial.rows, ["A"]);
          assert.equal(initial.extra, null);
          await Promise.all(pages.map((page) => page.locator("#case .expand").click()));
          const expanded = await compare("expanded", "section", 2);
          assert.deepEqual(expanded.rows, ["A", "B"]);
          assert.equal(expanded.extra, "Extra fallback");
          if (!switchRoot) {
            assert.deepEqual(warnings.filter((message) => !message.startsWith("Feature flags ") && /hydration|mismatch/i.test(message)), [], "Vue reported a hydration mismatch");
            assert.deepEqual(errors, []);
            return;
          }
          await Promise.all(pages.map((page) => page.locator("#case .switch").click()));
          await compare("root switch", "article", 2);
          assert.deepEqual(warnings.filter((message) => !message.startsWith("Feature flags ") && /hydration|mismatch/i.test(message)), [], "Vue reported a hydration mismatch");
          assert.deepEqual(errors, []);
        } finally {
          await Promise.all(pages.map((page) => page.close()));
          await browser.close();
        }
      });
      }
    }
  }
});
