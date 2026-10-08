import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";

import { compileScript, compileStyle, compileTemplate, parse as parseVue } from "@vue/compiler-sfc";
import { build } from "esbuild";
import { chromium, firefox, webkit, type BrowserType, type Page } from "playwright";

import { convertComponents, type ConversionGraph } from "../src/index.js";

import { assertPixelsEqual, launchParityBrowser } from "../../html-next/tests/pixel-parity.js";

const enabled = process.env.HTMLNEXT_TARGET_TEST === "1";
const nodeModulesPath = new URL("../../html-next/node_modules", import.meta.url).pathname;
const livePath = new URL("../../html-next/src/live.ts", import.meta.url).pathname;
const child = `<template component="x-graph-item" status="early" summary="Graph child.">
  <defs><prop name="label" type="string" default="Initial">Item label.</prop>
    <event name="saved" type="number"></event>
    <handler name="save"><dispatch event="saved" expr:value="1"></dispatch></handler></defs>
  <li on:click="save"><slot></slot><output $value="$label"></output></li>
  <style>:host { color: rgb(20 40 80); } :slotted(strong) { color: rgb(90 30 60); }</style>
</template>`;
const parent = `<link rel="component" href="./item.html">
<template component="x-graph-list" status="early" summary="Graph parent.">
  <defs><state type="number" name="count" value="0"></state><state type="boolean" name="active" value="true"></state><state type="number" name="rootHits" value="0"></state>
    <state type="number" name="saved" value="0"></state><state type="number" name="ancestorSaved" value="0"></state>
    <state type="number" name="rightHits" value="0"></state>
    <handler name="increment"><set name="count" expr:value="$count + 1"></set><set name="active" expr:value="not $active"></set></handler>
    <handler name="rootClick"><set name="rootHits" expr:value="$rootHits + 1"></set></handler>
    <handler name="recordSaved"><set name="saved" expr:value="$saved + 1"></set></handler>
    <handler name="recordAncestorSaved"><set name="ancestorSaved" expr:value="$ancestorSaved + 1"></set></handler>
    <handler name="recordRight"><set name="rightHits" expr:value="$rightHits + 1"></set></handler>
  </defs>
  <section on:click.stop.self="rootClick" on:saved="recordAncestorSaved"><button type="button" on:click="increment">Increment</button>
    <ul><x-graph-item from:label="concat('Item ', $count)" on:saved.stop="recordSaved" on:click.right="recordRight"><strong>Child: </strong></x-graph-item></ul>
    <output class="root-hits" $value="$rootHits"></output>
    <output class="saved-hits" $value="concat($saved, ':', $ancestorSaved)"></output>
    <output class="right-hits" $value="$rightHits"></output>
  </section>
  <style>:host { display: block; padding: 8px; background: rgb(225 235 245); } :host-state([active]) { background: rgb(200 220 240); }</style>
</template>`;

type Snapshot = { readonly behavior: { readonly tag: string; readonly text: string; readonly rootHits: string; readonly savedHits: string; readonly rightHits: string; readonly documentClicks: number; readonly documentSaved: number; readonly color: string; readonly background: string; readonly projectedColor: string }; readonly pixels: Buffer };

async function snapshot(page: Page, expected: string): Promise<Snapshot> {
  await page.waitForFunction((value) => document.querySelector("#case li")?.textContent?.replace(/\s/g, "") === value, expected);
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  return {
    behavior: await page.evaluate(() => {
      const root = document.querySelector("#case")!;
      const item = root.querySelector("li")!;
      return {
        tag: root.localName,
        text: item.textContent!.replace(/\s/g, ""),
        rootHits: root.querySelector(".root-hits")!.textContent!,
        savedHits: root.querySelector(".saved-hits")!.textContent!,
        rightHits: root.querySelector(".right-hits")!.textContent!,
        documentClicks: window.graphClicks,
        documentSaved: window.graphSaved,
        color: getComputedStyle(item).color,
        background: getComputedStyle(root).backgroundColor,
        projectedColor: getComputedStyle(item.querySelector("strong")!).color,
      };
    }),
    pixels: await page.locator("#case").screenshot({ animations: "disabled" }),
  };
}

describe.skipIf(!enabled)("public Vue application and library graph parity", () => {
  let directory = "";
  let liveBundle = "";
  const converted = new Map<ConversionGraph, { readonly bundle: string; readonly hydrateBundle: string; readonly css: string; readonly server: string }>();

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-vue-graph-parity-"));
    await mkdir(join(directory, "components"));
    await writeFile(join(directory, "components", "item.html"), child);
    await writeFile(join(directory, "components", "list.html"), parent);
    liveBundle = join(directory, "live.js");
    await build({ entryPoints: [livePath], outfile: liveBundle, bundle: true, format: "iife", globalName: "HtmlRuntime", platform: "browser", target: ["es2022"] });

    for (const mode of ["application", "library"] as const) {
      const outDirectory = join(directory, mode);
      const manifest = await convertComponents({ mode, target: "vue", entries: ["components/list.html"], root: directory, outDirectory });
      assert.deepEqual(manifest.components.map((component) => component.tag).sort(), ["x-graph-item", "x-graph-list"]);
      assert.deepEqual(manifest.entries.map((entry) => entry.tag), ["x-graph-list"]);
      assert.equal(manifest.output.entry, `vue/${mode === "application" ? "application" : "index"}.ts`);
      const styles: string[] = [];
      for (const component of manifest.components) {
        const file = join(outDirectory, component.artifact);
        const parsed = parseVue(await readFile(file, "utf8"), { filename: file });
        assert.deepEqual(parsed.errors, []);
        const scopeId = `data-v-graph-${mode}-${component.name.toLowerCase()}`;
        const script = compileScript(parsed.descriptor, { id: scopeId, inlineTemplate: true });
        await writeFile(file.replace(/\.vue$/, ".ts"), script.content);
        const serverScript = compileScript(parsed.descriptor, { id: scopeId });
        const serverTemplate = compileTemplate({
          source: parsed.descriptor.template!.content,
          filename: file,
          id: scopeId,
          ssr: true,
          ssrCssVars: [],
          scoped: parsed.descriptor.styles.some((style) => style.scoped === true),
          compilerOptions: { bindingMetadata: serverScript.bindings ?? {} },
        });
        assert.deepEqual(serverTemplate.errors, [], `${component.name} SSR compilation failed`);
        await writeFile(file.replace(/\.vue$/, ".ssr.ts"), `${serverScript.content.replace("export default", "const Component =")}
${serverTemplate.code}
export default Object.assign(Component, { ssrRender });
`);
        styles.push(...parsed.descriptor.styles.map((style) => {
          const compiled = compileStyle({ source: style.content, filename: file, id: scopeId, scoped: style.scoped === true });
          assert.deepEqual(compiled.errors, []);
          return compiled.code;
        }));
        await writeFile(file.replace(/\.vue$/, ".scope.ts"), `import component from "./${component.name}"; component.__scopeId = ${JSON.stringify(scopeId)};`);
      }
      const scopeImports = manifest.components.map((component) =>
        `import "./${component.artifact.replace(/\.vue$/, ".scope")}";`).join("\n");
      const itemArtifact = manifest.components.find((component) => component.tag === "x-graph-item")!.artifact;
      const entry = join(outDirectory, "entry.ts");
      const bundle = join(outDirectory, "vue.js");
      await writeFile(entry, `import { createApp, h } from "vue";
import { XGraphList } from "./vue/${mode === "application" ? "application" : "index"}";
${scopeImports}
createApp({ render: () => h(XGraphList, { id: "case" }) }).mount(document.querySelector("main"));\n`);
      await build({
        entryPoints: [entry], outfile: bundle, bundle: true, format: "iife", platform: "browser", target: ["es2022"], nodePaths: [nodeModulesPath],
        plugins: [{ name: "compiled-vue-sfc", setup(pluginBuild) {
          pluginBuild.onResolve({ filter: /\.vue$/ }, (args) => ({ path: resolve(args.resolveDir, args.path.replace(/\.vue$/, ".ts")) }));
        } }],
      });
      const hydrateEntry = join(outDirectory, "hydrate.ts");
      const hydrateBundle = join(outDirectory, "hydrate.js");
      await writeFile(hydrateEntry, `import { createSSRApp, h } from "vue";
import { XGraphList } from "./vue/${mode === "application" ? "application" : "index"}";
${scopeImports}
createSSRApp({ render: () => h(XGraphList, { id: "case" }) }).mount(document.querySelector("main"));\n`);
      await build({
        entryPoints: [hydrateEntry], outfile: hydrateBundle, bundle: true, format: "iife", platform: "browser", target: ["es2022"], nodePaths: [nodeModulesPath],
        plugins: [{ name: "compiled-vue-sfc", setup(pluginBuild) {
          pluginBuild.onResolve({ filter: /\.vue$/ }, (args) => ({ path: resolve(args.resolveDir, args.path.replace(/\.vue$/, ".ts")) }));
        } }],
      });
      const serverEntry = join(outDirectory, "server.ts");
      await writeFile(serverEntry, `import { createSSRApp, h } from "vue";
import { renderToString } from "@vue/server-renderer";
import { XGraphList } from "./vue/${mode === "application" ? "application" : "index"}";
import XGraphItem from "./${itemArtifact}";
XGraphItem.__scopeId = "data-v-graph-${mode}-xgraphitem";
XGraphList.__scopeId = "data-v-graph-${mode}-xgraphlist";
export const render = () => renderToString(createSSRApp({ render: () => h(XGraphList, { id: "case" }) }));\n`);
      const serverBuild = await build({
        entryPoints: [serverEntry], bundle: true, format: "esm", platform: "node", write: false, nodePaths: [nodeModulesPath],
        plugins: [{ name: "compiled-vue-sfc-ssr", setup(pluginBuild) {
          pluginBuild.onResolve({ filter: /\.vue$/ }, (args) => ({ path: resolve(args.resolveDir, args.path.replace(/\.vue$/, ".ssr.ts")) }));
        } }],
      });
      const serverModule = await import(`data:text/javascript;base64,${Buffer.from(serverBuild.outputFiles[0]!.text).toString("base64")}`);
      const server = await serverModule.render() as string;
      converted.set(mode, { bundle, hydrateBundle, css: styles.join("\n"), server });
    }
  });

  afterAll(async () => { if (directory !== "") await rm(directory, { recursive: true, force: true }); });

  for (const mode of ["application", "library"] as const) {
    for (const [engine, browserType] of [["Chromium", chromium], ["Firefox", firefox], ["WebKit", webkit]] as const satisfies ReadonlyArray<readonly [string, BrowserType]>) {
      it(`${engine} mounts and hydrates ${mode} nested behavior with identical pixels`, async () => {
        const browser = await launchParityBrowser(browserType);
        const [live, vue, hydrated] = await Promise.all([browser.newPage(), browser.newPage(), browser.newPage()]);
        const pages = [live, vue, hydrated];
        const errors: string[] = [];
        const warnings: string[] = [];
        try {
          for (const page of pages) page.on("pageerror", (error) => errors.push(error.message));
          hydrated.on("console", (message) => { if (message.type() === "warning") warnings.push(message.text()); });
          await live.setContent(`${child}${parent.slice(parent.indexOf("<template component"))}<main><x-graph-list id="case"></x-graph-list></main>`);
          await live.addScriptTag({ path: liveBundle });
          await live.evaluate(() => window.HtmlRuntime.lowerDocument());
          const output = converted.get(mode)!;
          await vue.setContent(`<style>${output.css}</style><main></main>`);
          await vue.addScriptTag({ path: output.bundle });
          await hydrated.setContent(`<style>${output.css}</style><main>${output.server}</main>`);
          await Promise.all(pages.map((page) => page.evaluate(() => {
            window.graphClicks = 0;
            window.graphSaved = 0;
          })));
          const [serverLive, serverVue] = await Promise.all([snapshot(live, "Child:Item0"), snapshot(hydrated, "Child:Item0")]);
          assert.deepEqual(serverVue.behavior, serverLive.behavior, "server-rendered graph behavior differs");
          await assertPixelsEqual(hydrated, serverVue.pixels, serverLive.pixels, "server-rendered graph pixels differ", live);
          await hydrated.addScriptTag({ path: output.hydrateBundle });
          await Promise.all(pages.map((page) => page.evaluate(() => {
            window.graphClicks = 0;
            window.graphSaved = 0;
            document.addEventListener("click", () => { window.graphClicks += 1; });
            document.addEventListener("saved", () => { window.graphSaved += 1; });
          })));
          for (const expected of ["Child:Item0", "Child:Item1"] as const) {
            const [liveResult, vueResult, hydratedResult] = await Promise.all([
              snapshot(live, expected), snapshot(vue, expected), snapshot(hydrated, expected),
            ]);
            assert.deepEqual(vueResult.behavior, liveResult.behavior);
            await assertPixelsEqual(vue, vueResult.pixels, liveResult.pixels, "graph pixels differ");
            assert.deepEqual(hydratedResult.behavior, liveResult.behavior, "hydrated graph behavior differs");
            await assertPixelsEqual(hydrated, hydratedResult.pixels, liveResult.pixels, "hydrated graph pixels differ");
            assert.equal(liveResult.behavior.rootHits, "0");
            assert.equal(liveResult.behavior.savedHits, "0:0");
            assert.equal(liveResult.behavior.rightHits, "0");
            assert.equal(liveResult.behavior.documentClicks, expected === "Child:Item0" ? 0 : 1);
            assert.equal(liveResult.behavior.documentSaved, 0);
            assert.equal(liveResult.behavior.background, expected === "Child:Item0" ? "rgb(200, 220, 240)" : "rgb(225, 235, 245)");
            assert.equal(liveResult.behavior.projectedColor, "rgb(90, 30, 60)");
            if (expected === "Child:Item0") {
              await Promise.all(pages.map((page) => page.locator("#case button").click()));
            }
          }
          await Promise.all(pages.map((page) => page.evaluate(() => {
            document.querySelector("#case")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          })));
          const [rootLive, rootVue, rootHydrated] = await Promise.all([
            snapshot(live, "Child:Item1"), snapshot(vue, "Child:Item1"), snapshot(hydrated, "Child:Item1"),
          ]);
          assert.deepEqual(rootVue.behavior, rootLive.behavior);
          await assertPixelsEqual(vue, rootVue.pixels, rootLive.pixels, "graph root pixels differ");
          assert.deepEqual(rootHydrated.behavior, rootLive.behavior);
          await assertPixelsEqual(hydrated, rootHydrated.pixels, rootLive.pixels, "hydrated graph root pixels differ");
          assert.equal(rootLive.behavior.rootHits, "1");
          assert.equal(rootLive.behavior.documentClicks, 1);
          await Promise.all(pages.map((page) => page.locator("#case li").click()));
          const [eventLive, eventVue, eventHydrated] = await Promise.all([
            snapshot(live, "Child:Item1"), snapshot(vue, "Child:Item1"), snapshot(hydrated, "Child:Item1"),
          ]);
          assert.deepEqual(eventVue.behavior, eventLive.behavior);
          await assertPixelsEqual(vue, eventVue.pixels, eventLive.pixels, "graph event pixels differ");
          assert.deepEqual(eventHydrated.behavior, eventLive.behavior);
          await assertPixelsEqual(hydrated, eventHydrated.pixels, eventLive.pixels, "hydrated graph event pixels differ", live);
          assert.equal(eventLive.behavior.savedHits, "1:0");
          assert.equal(eventLive.behavior.rightHits, "0");
          assert.equal(eventLive.behavior.documentSaved, 0);
          assert.equal(eventLive.behavior.documentClicks, 2);
          await Promise.all(pages.map((page) => page.evaluate(() => {
            document.querySelector("#case li")!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 2 }));
          })));
          const [rightLive, rightVue, rightHydrated] = await Promise.all([
            snapshot(live, "Child:Item1"), snapshot(vue, "Child:Item1"), snapshot(hydrated, "Child:Item1"),
          ]);
          assert.deepEqual(rightVue.behavior, rightLive.behavior);
          await assertPixelsEqual(vue, rightVue.pixels, rightLive.pixels, "graph event-option pixels differ");
          assert.deepEqual(rightHydrated.behavior, rightLive.behavior);
          await assertPixelsEqual(hydrated, rightHydrated.pixels, rightLive.pixels, "hydrated graph event-option pixels differ");
          assert.equal(rightLive.behavior.rightHits, "1");
          assert.equal(rightLive.behavior.savedHits, "2:0");
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
  interface Window { HtmlRuntime: { lowerDocument(): void }; graphClicks: number; graphSaved: number }
}
