import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { compileScript, parse } from "@vue/compiler-sfc";
import { build, type Plugin } from "esbuild";
import { JSDOM } from "jsdom";
import { chromium } from "playwright";
import { it } from "vitest";
import * as generation from "../src/generate.js";
import { parseComponent } from "../src/source-parser.js";

const root = fileURLToPath(new URL("../", import.meta.url));

async function preparedFixture(hydrate: boolean, ssrTemplate = false, partial = false): Promise<void> {
  const directory = await mkdtemp(join(root, ".vue-binding-preparation-"));
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    await writeFile(join(directory, "module.js"), `
      import { bindModule } from '@nextwebwg/html-next/bindings';
      export let loads = 0;
      const binding = bindModule({ props: { rows: {
        keepPrevious: true,
        input: ({ count }) => count,
        async load(count) {
          loads += 1;
          if (typeof window !== 'undefined') window.providerLoads = loads;
          return Array.from({ length: count }, (_, index) => count + ':' + index);
        }
      } }, connect() { if (typeof window !== 'undefined') window.providerConnected = true; } }, { browser: { source: 'fixture-v1' } });
      export const { connect, prepare, adopt } = binding;
    `);
    const label = parseComponent('<template component="prepared-label"><span><slot></slot></span></template>');
    await writeFile(join(directory, "PreparedLabel.vue"), generation.generateVueComponent(label));
    const native = parseComponent('<template component="native-date"><defs><prop name="value" type="string" default="2026-10-30">Date.</prop></defs><input id="partial-date" type="date" from:value="$value"></template>');
    await writeFile(join(directory, "NativeDate.vue"), generation.generateVueComponent(native));
    const definition = parseComponent(`<template component="prepared-rows" module="./module.js"><defs>
      <prop name="count" type="integer" default="2">Number of rows.</prop>
      <prop name="date" type="string" default="">Optional civil date.</prop>
      <prop name="rows" type="list(string)">Produced rows.</prop>
      </defs><section data-prepared-fixture><native-date></native-date><template $each="entry of [$date]" $key="'date'"><prepared-label>{format($entry, 'date', {}, 'en-GB')}</prepared-label></template><ol><template $each="row of $rows" $key="$row"><li>{$row}</li></template></ol></section></template>`);
    const source = generation.generateVueComponent(definition, {
      componentGraph: new Map([[definition.contract.tag, definition], [label.contract.tag, label], [native.contract.tag, native]]),
      modulePreparation: { source: "fixture-v1" },
    });
    const helpers: Plugin = { name: "helpers", setup(bundler) {
      bundler.onLoad({ filter: /\.vue$/ }, async args => {
        const descriptor = parse(await readFile(args.path, "utf8"), { filename: args.path }).descriptor;
        return { contents: compileScript(descriptor, { id: args.path, inlineTemplate: true, templateOptions: { ssr: ssrTemplate && bundler.initialOptions.platform === "node" } }).content, loader: "ts" };
      });
      bundler.onResolve({ filter: /^\.\/(host|props|bindings|control)$/ }, args => ({ path: args.path.slice(2), namespace: "fixture-helper" }));
      bundler.onLoad({ filter: /.*/, namespace: "fixture-helper" }, args => {
        const helper = args.path === "bindings" ? generation.vueBindingsArtifact() : args.path === "host" ? generation.vueHostArtifact() : args.path === "control" ? generation.vueControlArtifact() : generation.vuePropsArtifact();
        return { contents: helper.content, loader: "ts", resolveDir: root };
      });
      bundler.onResolve({ filter: /^@nextwebwg\/html-next\/bindings$/ }, () => ({ path: join(root, "src/bindings.ts") }));
      bundler.onResolve({ filter: /^@nextwebwg\/html-next\/inputs$/ }, () => ({ path: join(root, "src/component-inputs.ts") }));
    } };
    for (const server of [true, false]) {
      const descriptor = parse(source, { filename: "PreparedRows.vue" }).descriptor;
      const component = compileScript(descriptor, { id: "prepared-rows", inlineTemplate: true, templateOptions: { ssr: server && ssrTemplate } }).content;
      await writeFile(join(directory, server ? "server-component.ts" : "client-component.ts"), component);
    }
    await writeFile(join(directory, "server-entry.ts"), `
      import { createSSRApp, h } from 'vue';
      import { renderToString } from '@vue/server-renderer';
      import Component from './server-component';
      export { loads } from './module.js';
      export const render = props => renderToString(createSSRApp({ render: () => h(Component, props) }));
    `);
    await build({ entryPoints: [join(directory, "server-entry.ts")], outfile: join(directory, "server.mjs"), bundle: true,
      format: "esm", platform: "node", external: ["vue", "@vue/server-renderer"], plugins: [helpers], logLevel: "silent" });
    const server = await import(pathToFileURL(join(directory, "server.mjs")).href) as { render(props: object): Promise<string>; loads: number };
    const html = await server.render({ count: 2 });
    const document = new JSDOM(html).window.document;
    assert.deepEqual([...document.querySelectorAll("li")].map(node => node.textContent), ["2:0", "2:1"]);
    assert.equal(server.loads, 1, "one server read prepares the output");
    assert.ok(document.querySelector("[data-html-next-bindings]"));
    const supplied = await server.render({ count: 9, rows: ["Caller"] });
    assert.equal(new JSDOM(supplied).window.document.querySelector("li")!.textContent, "Caller");
    assert.equal(server.loads, 1, "caller fixtures bypass production");
    if (!hydrate) return;

    await writeFile(join(directory, "client-entry.ts"), `
      import { createSSRApp, h, reactive } from 'vue';
      import Component from './client-component';
      const props = reactive({ count: 2 });
      window.fixture = props;
      createSSRApp({ render: () => h(Component, props) }).mount('#app');
    `);
    await build({ entryPoints: [join(directory, "client-entry.ts")], outfile: join(directory, "client.js"), bundle: true,
      format: "iife", platform: "browser", plugins: [helpers], logLevel: "silent",
      define: { __VUE_OPTIONS_API__: "true", __VUE_PROD_DEVTOOLS__: "false", __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: "true" } });
    browser = await chromium.launch();
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { if (message.type() === "warning" || message.type() === "error") errors.push(message.text()); });
    await page.setContent(`<div id="app">${html}</div>`);
    await page.evaluate(() => { (window as any).firstRow = document.querySelector("li"); });
    if (partial) {
      await page.locator('#partial-date').fill("");
      await page.locator('#partial-date').press("1");
      assert.equal(await page.locator('#partial-date').evaluate(input => (input as HTMLInputElement).validity.badInput), true);
    }
    await page.addScriptTag({ content: await readFile(join(directory, "client.js"), "utf8") });
    await page.waitForFunction(() => (window as any).providerConnected);
    if (partial) {
      assert.equal(await page.locator('#partial-date').evaluate(input => (input as HTMLInputElement).validity.badInput), true, "hydration must preserve opaque native date segments");
      assert.equal(await page.locator('#partial-date').evaluate(input => (input as HTMLInputElement).defaultValue), "", "the authored reset default is still restored");
    }
    assert.equal(await page.evaluate(() => document.querySelector("li") === (window as any).firstRow), true);
    assert.equal(await page.evaluate(() => (window as any).providerLoads ?? 0), 0, "hydration reuses the server read");
    await page.evaluate(() => { (window as any).fixture.count = 3; });
    await page.waitForFunction(() => document.querySelectorAll("li").length === 3);
    assert.equal(await page.locator("li").first().textContent(), "3:0");
    await page.evaluate(() => { (window as any).fixture.rows = ["Caller"]; (window as any).fixture.count = 4; });
    await page.waitForFunction(() => document.querySelector("li")?.textContent === "Caller");
    await page.evaluate(() => { (window as any).fixture.rows = undefined; });
    await page.waitForFunction(() => document.querySelectorAll("li").length === 4);
    await page.evaluate(() => { (window as any).fixture.date = "2024-02-29"; });
    await page.waitForFunction(() => document.querySelector("span")?.textContent === "29 Feb 2024");
    await page.evaluate(() => { (window as any).fixture.date = "invalid"; });
    assert.equal(await page.locator("span").textContent(), "29 Feb 2024", "invalid formatted text retains its last accepted content");
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await rm(directory, { recursive: true, force: true });
  }
}

it("prepares bound module outputs before Vue SSR without replacing caller fixtures", async () => {
  await preparedFixture(false);
  await preparedFixture(false, true);
});
it.skipIf(process.env.HTMLNEXT_TARGET_TEST !== "1")("adopts prepared producer ownership before Vue hydration", () => preparedFixture(true));
it.skipIf(process.env.HTMLNEXT_TARGET_TEST !== "1")("preserves opaque native date segments while restoring hydration defaults", () => preparedFixture(true, false, true));
