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
const browserLoaderPath = new URL("../../html-next/src/browser-loader.ts", import.meta.url).pathname;
const child = `<template component="x-keyed-item" status="early" summary="Keyed child." controller="./item.js"><defs>
  <prop name="itemId" type="string">Item identity.</prop>
  <prop name="label" type="string">Item label.</prop>
</defs><li from:data-id="itemId"><input><span $value="label"></span></li></template>`;
const controller = `export default function connect(host) {
  const id = host.state.itemId;
  window.keyedLifecycle.push("connect:" + id);
  return () => window.keyedLifecycle.push("disconnect:" + id);
}`;
const parent = `<link rel="component" href="./item.html">
<template component="x-keyed-list" status="early" summary="Keyed parent."><defs>
  <state type="list(unknown)" name="rows" value="[{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }]"></state>
  <handler name="reorder"><set name="rows" expr:value="[{ id: 'c', label: 'C' }, { id: 'a', label: 'A' }, { id: 'b', label: 'Bee' }]"></set></handler>
  <handler name="remove"><set name="rows" expr:value="[{ id: 'c', label: 'C' }, { id: 'b', label: 'Bee' }]"></set></handler>
  <handler name="restore"><set name="rows" expr:value="[{ id: 'c', label: 'C' }, { id: 'b', label: 'Bee' }, { id: 'a', label: 'Again' }]"></set></handler>
  <handler name="duplicate"><set name="rows" expr:value="[{ id: 'a', label: 'One' }, { id: 'a', label: 'Two' }]"></set></handler>
</defs><section><button type="button" class="reorder" on:click="reorder">Reorder</button>
  <button type="button" class="remove" on:click="remove">Remove</button>
  <button type="button" class="restore" on:click="restore">Restore</button>
  <button type="button" class="duplicate" on:click="duplicate">Duplicate</button>
  <ul><x-keyed-item $each="row of rows" $key="row.id" from:item-id="row.id" from:label="row.label"></x-keyed-item></ul>
</section></template>`;

type State = {
  readonly order: readonly string[];
  readonly labels: readonly string[];
  readonly edited: string;
  readonly lifecycle: readonly string[];
};

async function snapshot(page: Page, order: readonly string[], lifecycleCount: number): Promise<{ readonly behavior: State; readonly pixels: Buffer }> {
  await page.waitForFunction(([ids, count]) => {
    const actual = Array.from(document.querySelectorAll("#case li"), (row) => row.getAttribute("data-id"));
    return JSON.stringify(actual) === JSON.stringify(ids) && window.keyedLifecycle.length === count;
  }, [order, lifecycleCount]);
  await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
  return {
    behavior: await page.evaluate(() => ({
      order: Array.from(document.querySelectorAll("#case li"), (row) => row.getAttribute("data-id")!),
      labels: Array.from(document.querySelectorAll("#case li span"), (label) => label.textContent!),
      edited: document.querySelector<HTMLInputElement>('#case li[data-id="b"] input')!.value,
      lifecycle: [...window.keyedLifecycle].sort(),
    })),
    pixels: await page.locator("#case").screenshot({ animations: "disabled" }),
  };
}

describe.skipIf(!enabled)("public Vue converter keyed nested-component parity", () => {
  let directory = "";
  let loaderBundle = "";
  const converted = new Map<ConversionGraph, { readonly fresh: string; readonly hydrate: string; readonly server: string }>();

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-vue-keyed-parity-"));
    await mkdir(join(directory, "components"));
    await writeFile(join(directory, "components", "item.html"), child);
    await writeFile(join(directory, "components", "item.js"), controller);
    await writeFile(join(directory, "components", "list.html"), parent);
    loaderBundle = join(directory, "loader.js");
    await build({ entryPoints: [browserLoaderPath], outfile: loaderBundle, bundle: true, format: "iife", globalName: "HtmlNextLoader", platform: "browser", target: ["es2022"] });

    for (const mode of ["application", "library"] as const) {
      const outDirectory = join(directory, mode);
      const manifest = await convertComponents({ mode, target: "vue", entries: ["components/list.html"], root: directory, outDirectory });
      assert.deepEqual(manifest.components.map((component) => component.tag).sort(), ["x-keyed-item", "x-keyed-list"]);
      assert.equal(manifest.output.entry, `vue/${mode === "application" ? "application" : "index"}.ts`);
      for (const component of manifest.components) {
        const file = join(outDirectory, component.artifact);
        const parsed = parseVue(await readFile(file, "utf8"), { filename: file });
        assert.deepEqual(parsed.errors, []);
        await writeFile(file.replace(/\.vue$/, ".ts"), compileScript(parsed.descriptor, { id: `keyed-${mode}-${component.name}`, inlineTemplate: true }).content);
        const serverScript = compileScript(parsed.descriptor, { id: `keyed-${mode}-${component.name}` });
        const serverTemplate = compileTemplate({
          source: parsed.descriptor.template!.content,
          filename: file,
          id: `keyed-${mode}-${component.name}`,
          ssr: true,
          ssrCssVars: [],
          compilerOptions: { bindingMetadata: serverScript.bindings ?? {} },
        });
        assert.deepEqual(serverTemplate.errors, []);
        await writeFile(file.replace(/\.vue$/, ".ssr.ts"), `${serverScript.content.replace("export default", "const Component =")}
${serverTemplate.code}
export default Object.assign(Component, { ssrRender });
`);
      }
      const entry = join(outDirectory, "entry.ts");
      const bundle = join(outDirectory, "vue.js");
      await writeFile(entry, `import { createApp, h, onErrorCaptured } from "vue";
import { XKeyedList } from "./vue/${mode === "application" ? "application" : "index"}";
window.keyedLifecycle = [];
window.vueKeyedDiagnostics = [];
window.vueCapturedKeyedDiagnostics = [];
const app = createApp({
  setup() {
    onErrorCaptured((error) => { window.vueCapturedKeyedDiagnostics.push(error.message); });
    return () => h(XKeyedList, { id: "case" });
  },
});
app.config.errorHandler = (error) => window.vueKeyedDiagnostics.push({ name: error.name, code: error.diagnostic?.code ?? null, message: error.message });
app.mount(document.querySelector("main"));\n`);
      await build({
        entryPoints: [entry], outfile: bundle, bundle: true, format: "iife", platform: "browser", target: ["es2022"], nodePaths: [nodeModulesPath],
        plugins: [{ name: "compiled-vue-sfc", setup(pluginBuild) {
          pluginBuild.onResolve({ filter: /\.vue$/ }, (args) => ({ path: resolve(args.resolveDir, args.path.replace(/\.vue$/, ".ts")) }));
        } }],
      });
      const hydrateEntry = join(outDirectory, "hydrate.ts");
      const hydrate = join(outDirectory, "hydrate.js");
      await writeFile(hydrateEntry, `import { createSSRApp, h } from "vue";
import { XKeyedList } from "./vue/${mode === "application" ? "application" : "index"}";
window.keyedLifecycle = [];
createSSRApp({ render: () => h(XKeyedList, { id: "case" }) }).mount(document.querySelector("main"));\n`);
      await build({
        entryPoints: [hydrateEntry], outfile: hydrate, bundle: true, format: "iife", platform: "browser", target: ["es2022"], nodePaths: [nodeModulesPath],
        plugins: [{ name: "compiled-vue-sfc", setup(pluginBuild) {
          pluginBuild.onResolve({ filter: /\.vue$/ }, (args) => ({ path: resolve(args.resolveDir, args.path.replace(/\.vue$/, ".ts")) }));
        } }],
      });
      const serverEntry = join(outDirectory, "server.ts");
      await writeFile(serverEntry, `import { createSSRApp, h } from "vue";
import { renderToString } from "@vue/server-renderer";
import { XKeyedList } from "./vue/${mode === "application" ? "application" : "index"}";
export const render = () => renderToString(createSSRApp({ render: () => h(XKeyedList, { id: "case" }) }));\n`);
      const serverBuild = await build({
        entryPoints: [serverEntry], bundle: true, format: "esm", platform: "node", write: false, nodePaths: [nodeModulesPath],
        plugins: [{ name: "compiled-vue-sfc-ssr", setup(pluginBuild) {
          pluginBuild.onResolve({ filter: /\.vue$/ }, (args) => ({ path: resolve(args.resolveDir, args.path.replace(/\.vue$/, ".ssr.ts")) }));
        } }],
      });
      const serverModule = await import(`data:text/javascript;base64,${Buffer.from(serverBuild.outputFiles[0]!.text).toString("base64")}`);
      const server = await serverModule.render() as string;
      assert.match(server, /<li[^>]*data-id="a"/);
      converted.set(mode, { fresh: bundle, hydrate, server });
    }
  });

  afterAll(async () => { if (directory !== "") await rm(directory, { recursive: true, force: true }); });

  for (const mode of ["application", "library"] as const) {
    for (const [engine, browserType] of [["Chromium", chromium], ["Firefox", firefox], ["WebKit", webkit]] as const satisfies ReadonlyArray<readonly [string, BrowserType]>) {
      it(`${engine} hydrates and updates keyed ${mode} rows`, async () => {
        const browser = await launchParityBrowser(browserType);
        const [live, hydrated] = await Promise.all([browser.newPage(), browser.newPage()]);
        const pages = [live, hydrated];
        const errors: string[] = [];
        const warnings: string[] = [];
        try {
          for (const page of pages) {
            page.on("pageerror", (error) => errors.push(error.message));
            await page.route("https://app.example/**", async (route) => {
              const url = route.request().url();
              if (url.endsWith("/components/list.html")) await route.fulfill({ contentType: "text/html", body: parent });
              else if (url.endsWith("/components/item.html")) await route.fulfill({ contentType: "text/html", body: child });
              else if (url.endsWith("/components/item.js")) await route.fulfill({ contentType: "text/javascript", body: controller });
              else await route.fulfill({ contentType: "text/html", body: page === live
                ? `<link rel="component" href="/components/list.html"><main><x-keyed-list id="case"></x-keyed-list></main>`
                : `<main>${converted.get(mode)!.server}</main>` });
            });
          }
          hydrated.on("console", (message) => { if (message.type() === "warning") warnings.push(message.text()); });
          await Promise.all([live.goto("https://app.example/live"), hydrated.goto("https://app.example/hydrated")]);
          assert.equal(await hydrated.locator("#case li").count(), 3, "SSR must render the authored keyed rows");
          await live.evaluate(() => { window.keyedLifecycle = []; });
          await live.addScriptTag({ path: loaderBundle });
          await live.evaluate(() => window.HtmlNextLoader.startBrowserComponents());
          await hydrated.addScriptTag({ path: converted.get(mode)!.hydrate });
          const compare = async (stage: string, order: readonly string[], lifecycleCount: number) => {
            await Promise.all(pages.map((page) => page.waitForFunction(([ids, count]) =>
              JSON.stringify(Array.from(document.querySelectorAll("#case li"), (row) => row.getAttribute("data-id"))) === JSON.stringify(ids) &&
              window.keyedLifecycle.length === count, [order, lifecycleCount])));
            await Promise.all(pages.map((page) => page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))))));
            const read = async (page: Page) => ({
              behavior: await page.evaluate(() => ({
                order: Array.from(document.querySelectorAll("#case li"), (row) => row.getAttribute("data-id")),
                labels: Array.from(document.querySelectorAll("#case li span"), (label) => label.textContent),
                lifecycle: [...window.keyedLifecycle].sort(),
              })),
              pixels: await page.locator("#case").screenshot({ animations: "disabled" }),
            });
            const [actualLive, actualHydrated] = await Promise.all([read(live), read(hydrated)]);
            assert.deepEqual(actualHydrated.behavior, actualLive.behavior, `${stage} keyed behavior differs`);
            await assertPixelsEqual(hydrated, actualHydrated.pixels, actualLive.pixels, `${stage} keyed pixels differ`, live);
            return actualLive.behavior;
          };
          assert.deepEqual((await compare("initial", ["a", "b", "c"], 3)).labels, ["A", "B", "C"]);
          await Promise.all(pages.map((page) => page.locator("#case .reorder").click()));
          assert.deepEqual((await compare("reordered", ["c", "a", "b"], 3)).labels, ["C", "A", "Bee"]);
          await Promise.all(pages.map((page) => page.locator("#case .remove").click()));
          assert.deepEqual((await compare("removed", ["c", "b"], 4)).lifecycle, ["connect:a", "connect:b", "connect:c", "disconnect:a"]);
          await Promise.all(pages.map((page) => page.locator("#case .restore").click()));
          assert.deepEqual((await compare("restored", ["c", "b", "a"], 5)).labels, ["C", "Bee", "Again"]);
          assert.deepEqual(warnings.filter((message) => !message.startsWith("Feature flags ") && /hydration|mismatch/i.test(message)), [], "Vue reported a hydration mismatch");
          assert.deepEqual(errors, []);
        } finally {
          await Promise.all(pages.map((page) => page.close()));
          await browser.close();
        }
      });

      it(`${engine} preserves keyed behavior and disposes removed ${mode} children`, async () => {
        const browser = await launchParityBrowser(browserType);
        const [live, vue] = await Promise.all([browser.newPage(), browser.newPage()]);
        const liveErrors: string[] = [];
        const vueErrors: string[] = [];
        try {
          live.on("pageerror", (error) => liveErrors.push(error.message));
          vue.on("pageerror", (error) => vueErrors.push(error.message));
          for (const page of [live, vue]) {
            await page.route("https://app.example/**", async (route) => {
              const url = route.request().url();
              if (url.endsWith("/components/list.html")) await route.fulfill({ contentType: "text/html", body: parent });
              else if (url.endsWith("/components/item.html")) await route.fulfill({ contentType: "text/html", body: child });
              else if (url.endsWith("/components/item.js")) await route.fulfill({ contentType: "text/javascript", body: controller });
              else await route.fulfill({ contentType: "text/html", body: page === live
                ? `<link rel="component" href="/components/list.html"><main><x-keyed-list id="case"></x-keyed-list></main>`
                : "<main></main>" });
            });
          }
          await Promise.all([live.goto("https://app.example/live"), vue.goto("https://app.example/vue")]);
          await live.evaluate(() => { window.keyedLifecycle = []; });
          await live.addScriptTag({ path: loaderBundle });
          await live.evaluate(() => window.HtmlNextLoader.startBrowserComponents());
          await vue.addScriptTag({ path: converted.get(mode)!.fresh });
          await Promise.all([live, vue].map((page) => page.waitForFunction(() => window.keyedLifecycle.length === 3)));
          await Promise.all([live, vue].map((page) => page.evaluate(() => {
            document.querySelector<HTMLInputElement>('#case li[data-id="b"] input')!.value = "user edit";
          })));
          const compare = async (stage: string, order: readonly string[], count: number) => {
            const [actualLive, actualVue] = await Promise.all([snapshot(live, order, count), snapshot(vue, order, count)]);
            assert.deepEqual(actualVue.behavior, actualLive.behavior, `${stage} behavior differs`);
            await assertPixelsEqual(vue, actualVue.pixels, actualLive.pixels, `${stage} pixels differ`, live);
            return actualLive.behavior;
          };
          assert.deepEqual((await compare("initial", ["a", "b", "c"], 3)).lifecycle, ["connect:a", "connect:b", "connect:c"]);
          await Promise.all([live, vue].map((page) => page.locator("#case .reorder").click()));
          assert.deepEqual(await compare("reordered", ["c", "a", "b"], 3), {
            order: ["c", "a", "b"], labels: ["C", "A", "Bee"], edited: "user edit",
            lifecycle: ["connect:a", "connect:b", "connect:c"],
          });
          await Promise.all([live, vue].map((page) => page.locator("#case .remove").click()));
          assert.deepEqual(await compare("removed", ["c", "b"], 4), {
            order: ["c", "b"], labels: ["C", "Bee"], edited: "user edit",
            lifecycle: ["connect:a", "connect:b", "connect:c", "disconnect:a"],
          });
          await Promise.all([live, vue].map((page) => page.locator("#case .restore").click()));
          assert.deepEqual(await compare("restored", ["c", "b", "a"], 5), {
            order: ["c", "b", "a"], labels: ["C", "Bee", "Again"], edited: "user edit",
            lifecycle: ["connect:a", "connect:a", "connect:b", "connect:c", "disconnect:a"],
          });
          assert.deepEqual(liveErrors, []);
          assert.deepEqual(vueErrors, []);
          const liveFailure = live.waitForEvent("pageerror");
          await Promise.all([live, vue].map((page) => page.locator("#case .duplicate").click()));
          assert.equal((await liveFailure).message, "HR004: A keyed list produced duplicate key `a`.");
          await vue.waitForFunction(() => window.vueKeyedDiagnostics.length > 0);
          assert.deepEqual(await vue.evaluate(() => window.vueKeyedDiagnostics), [{
            name: "HtmlDiagnosticError", code: "HR004", message: liveErrors[0],
          }], "duplicate-key diagnostic differs");
          assert.deepEqual(await vue.evaluate(() => window.vueCapturedKeyedDiagnostics), [liveErrors[0]], "Vue ancestor did not capture the keyed-list error");
          assert.deepEqual(vueErrors, []);
          const afterFailure = await Promise.all([live, vue].map((page) => page.evaluate(() => ({
            root: document.querySelector("#case")?.localName ?? null,
            restore: document.querySelector("#case .restore") !== null,
            rows: Array.from(document.querySelectorAll("#case li"), (row) => row.getAttribute("data-id")),
          }))));
          assert.deepEqual(afterFailure[1], afterFailure[0], "duplicate key changed the mounted component differently");
          await Promise.all([live, vue].map((page) => page.locator("#case .restore").click()));
          await compare("recovered after duplicate key", ["c", "b", "a"], 5);
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
    keyedLifecycle: string[];
    vueKeyedDiagnostics: { name: string; code: string | null; message: string }[];
    vueCapturedKeyedDiagnostics: string[];
  }
}
