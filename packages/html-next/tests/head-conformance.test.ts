import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, it } from "vitest";

import { build } from "esbuild";
import { chromium, firefox, webkit, type BrowserType } from "playwright";

import { parseComponentResource } from "../src/source-parser.js";
import { renderComponents } from "../src/server.js";
import { authoredHead, expectedHead, expectedScripts, headFiles, runHeadScenario, runScriptScenario, scriptFiles, scriptSources } from "./head-scenario.js";

/**
 * Head declarations (https://nextwebwg.org/declarative-components/components#head-management) in the
 * live runtime, in Chromium, Firefox and WebKit: insertion and removal, shared and competing keys,
 * restoring the authored head as the same nodes, meta lists, the page-wide head entry rule with and
 * without a `component-src` list, JSON-LD, and a page change as one reconciliation.
 */
const enabled = process.env.HTMLNEXT_BROWSER_TEST === "1";
const source = fileURLToPath(new URL("../src/", import.meta.url));

/** The live page: component links, an import map for the bare imports, and `app` acting on the DOM. */
function livePage(listed: boolean): string {
  const imports = { "@vendor/": "https://vendor.example/ui/", "@cdn/": "https://cdn.acme.example/ui/" };
  return `<!doctype html><head>${authoredHead(listed)}<script type="importmap">${JSON.stringify({ imports })}</script></head><body>
<link rel="component" href="/app.html"><link rel="component" href="@vendor/widget.html">
<link rel="component" href="${listed ? "https://cdn.acme.example/ui/badge.html" : "@cdn/badge.html"}">
<div id="mount"></div></body>`;
}

const liveApp = `const mount = () => document.querySelector("#mount");
const root = (tag) => mount().querySelector('[data-component~="' + tag + '"]');
globalThis.alert = () => { globalThis.alerted = true; };
globalThis.app = {
  mount() {
    mount().innerHTML = '<docs-layout><page-a></page-a></docs-layout><img-card></img-card><img-card></img-card>' +
      '<x-product></x-product><x-product></x-product><vendor-widget></vendor-widget><cdn-badge></cdn-badge>';
  },
  section(text) { HtmlNextLive.updateComponentProps(root("page-a"), { section: text }); },
  note(shown) { if (shown) root("page-a").append(document.createElement("x-note")); else root("x-note").remove(); },
  cards(count) { const cards = mount().querySelectorAll('[data-component~="img-card"]'); for (const card of [...cards].slice(count)) card.remove(); },
  schema(value) { HtmlNextLive.updateComponentProps(root("x-product"), { schema: value }); },
  page(name) { root("page-a").replaceWith(document.createElement("page-" + name)); },
  unmount() { mount().replaceChildren(); },
};`;

const liveScripts = `const mount = () => document.querySelector("#mount");
const removed = new Map();
globalThis.scripts = {
  mount() {
    mount().innerHTML = '<saved-cards id="a"></saved-cards><saved-cards id="b"></saved-cards><pay-badge></pay-badge>' +
      '<div style="height: 6000px"></div><checkout-form id="lazy"></checkout-form><map-view id="maps"></map-view>';
  },
  remove(id) { const root = document.getElementById(id); removed.set(id, root); root.remove(); },
  restore(id) { mount().prepend(removed.get(id)); },
  unmount() { mount().replaceChildren(); },
};`;

/** Serves the scripts, counting requests; the shared one arrives late. */
async function routeScripts(page: import("playwright").Page, body: () => string): Promise<string[]> {
  const requested: string[] = [];
  await page.route(/^https:\/\/(?:app|js)\.example\//, async (route) => {
    const url = new URL(route.request().url());
    const name = url.pathname.split("/").at(-1)!;
    const headers = { "access-control-allow-origin": "*" };
    if (url.hostname === "js.example") {
      requested.push(name);
      if (name === "sdk.js") await new Promise((resolve) => setTimeout(resolve, 400));
      return route.fulfill({ contentType: "text/javascript", body: scriptSources[name]!, headers });
    }
    if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: body(), headers });
    const file = scriptFiles[name] ?? headFiles[name];
    return file === undefined ? route.fulfill({ status: 404 }) : route.fulfill({ contentType: name.endsWith(".js") ? "text/javascript" : "text/html", body: file, headers });
  });
  return requested;
}

describe.skipIf(!enabled)("head declarations in the live runtime, in every engine", () => {
  let directory = "";
  let bundle = "";

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-head-"));
    const entry = join(directory, "entry.ts");
    await writeFile(entry, `export * from ${JSON.stringify(join(source, "browser-loader.ts"))};
export { updateComponentProps } from ${JSON.stringify(join(source, "runtime.ts"))};\n`);
    bundle = join(directory, "live.js");
    await build({ entryPoints: [entry], outfile: bundle, bundle: true, format: "iife", globalName: "HtmlNextLive", platform: "browser", target: ["es2022"] });
  });
  afterAll(async () => { if (directory !== "") await rm(directory, { recursive: true, force: true }); });

  for (const [engine, browserType] of [["Chromium", chromium], ["Firefox", firefox], ["WebKit", webkit]] as const satisfies ReadonlyArray<readonly [string, BrowserType]>) {
    for (const listed of [false, true]) {
      it(`${engine} reconciles the head ${listed ? "with" : "without"} a component-src list`, async () => {
        const browser = await browserType.launch({ headless: true });
        const errors: string[] = [];
        try {
          const page = await browser.newPage();
          page.setDefaultTimeout(10_000);
          page.on("pageerror", (error) => errors.push(error.message));
          // A preconnect to these test hosts fails at the network, as it would for any page.
          page.on("console", (message) => { if (message.type() === "error" && !message.text().startsWith("Failed to preconnect")) errors.push(message.text()); });
          const warnings: string[] = [];
          page.on("console", (message) => { if (message.type() === "warning") warnings.push(message.text().split(": ").slice(1, 2).join("")); });
          await page.route(/^https:\/\/(?:app|vendor|cdn\.acme)\.example\//, (route) => {
            const url = new URL(route.request().url());
            const name = url.pathname.split("/").at(-1)!;
            const headers = { "access-control-allow-origin": "*" };
            if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: livePage(listed), headers });
            return Object.hasOwn(headFiles, name) ? route.fulfill({ contentType: "text/html", body: headFiles[name]!, headers }) : route.fulfill({ status: 404, headers });
          });
          await page.goto("https://app.example/");
          await page.addScriptTag({ path: bundle });
          await page.evaluate(() => (window as unknown as { HtmlNextLive: { startBrowserComponents(): Promise<unknown> } }).HtmlNextLive.startBrowserComponents());
          await page.addScriptTag({ content: liveApp });
          const steps = await runHeadScenario(page);
          assert.deepEqual(steps, expectedHead(listed));
          assert.deepEqual(errors, []);
          // The imported widget's canonical link and theme color are ignored with a diagnostic, and so
          // is the badge's theme color when it is imported.
          assert.deepEqual(warnings.filter((code) => code === "HL011").length, listed ? 2 : 3);
        } finally {
          await browser.close();
        }
      });
    }

    it(`${engine} shares declared scripts and runs on:load once per connection, with lazy and manual loading`, async () => {
      const browser = await browserType.launch({ headless: true });
      const errors: string[] = [];
      try {
        const page = await browser.newPage();
        page.setDefaultTimeout(10_000);
        page.on("pageerror", (error) => errors.push(error.message));
        const requested = await routeScripts(page, () => '<!doctype html><head><title>Scripts</title></head><body><link rel="component" href="/scripts.html"><div id="mount"></div></body>');
        await page.goto("https://app.example/");
        await page.addScriptTag({ path: bundle });
        await page.evaluate(() => (window as unknown as { HtmlNextLive: { startBrowserComponents(): Promise<unknown> } }).HtmlNextLive.startBrowserComponents());
        await page.addScriptTag({ content: liveScripts });
        assert.deepEqual(await runScriptScenario(page), expectedScripts);
        // The browser fetched each script once.
        assert.deepEqual(requested, ["sdk.js", "lazy.js", "maps.js"]);
        assert.deepEqual(errors, []);
      } finally {
        await browser.close();
      }
    });

    it(`${engine} hydrates server output: adopts its head, inserts an eager script once from its preload, and restores the set-aside title`, async () => {
      const checkout = `<template component="page-checkout"><defs>
        <state name="loads" type="number" value="0"></state>
        <handler name="loaded"><set name="loads" expr:value="$loads + 1"></set></handler>
        <title>Checkout · Acme</title><link rel="preconnect" href="https://js.example">
        <script name="sdk" src="https://js.example/sdk.js" crossorigin="anonymous" on:load="loaded"></script>
      </defs><main from:data-loads="$loads"><p>Pay</p></main></template>
      <template component="x-product"><defs>
        <prop name="name" type="string" default="Anvil">The name.</prop>
        <script type="application/ld+json" from:value="{ name: $name }"></script>
      </defs><section></section></template>`;
      const files = { "checkout.html": checkout };
      const rendered = await renderComponents('<page-checkout id="checkout"></page-checkout><x-product id="product"></x-product><x-product></x-product>', {
        definitions: parseComponentResource(checkout, "https://app.example/checkout.html").definitions,
        head: "<title>Acme</title>", url: "https://app.example/",
      });
      const browser = await browserType.launch({ headless: true });
      const errors: string[] = [];
      try {
        const page = await browser.newPage();
        page.setDefaultTimeout(10_000);
        page.on("pageerror", (error) => errors.push(error.message));
        const requested: string[] = [];
        await page.route(/^https:\/\/(?:app|js)\.example\//, async (route) => {
          const url = new URL(route.request().url());
          const name = url.pathname.split("/").at(-1)!;
          const headers = { "access-control-allow-origin": "*" };
          if (url.hostname === "js.example") {
            requested.push(name);
            return route.fulfill({ contentType: "text/javascript", body: scriptSources[name]!, headers });
          }
          if (url.pathname === "/") {
            return route.fulfill({ contentType: "text/html; charset=utf-8", headers,
              body: `<!doctype html><head><meta charset="utf-8">${rendered.head}</head><body><link rel="component" href="/checkout.html"><div id="mount">${rendered.html}</div></body>` });
          }
          return route.fulfill({ contentType: "text/html", body: files[name as keyof typeof files], headers });
        });
        await page.goto("https://app.example/");
        const before = await page.evaluate(() => {
          const kept = globalThis as unknown as Record<string, unknown>;
          kept.serverTitle = document.querySelector("title");
          kept.authoredTitle = document.querySelector<HTMLTemplateElement>("template[data-component-head]")?.content.firstElementChild;
          kept.serverJson = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
          return { title: document.title, preloads: document.querySelectorAll('link[rel="preload"]').length,
            scripts: document.querySelectorAll('script:not([type="application/ld+json"])').length, json: (kept.serverJson as Element[]).map((block) => block.textContent) };
        });
        // Two instances with identical JSON-LD write two blocks.
        assert.deepEqual(before, { title: "Checkout · Acme", preloads: 1, scripts: 0, json: ['{"name":"Anvil"}', '{"name":"Anvil"}'] });
        await page.addScriptTag({ path: bundle });
        await page.evaluate(() => (window as unknown as { HtmlNextLive: { startBrowserComponents(): Promise<unknown> } }).HtmlNextLive.startBrowserComponents());
        await page.waitForFunction(() => document.getElementById("checkout")?.getAttribute("data-loads") === "1");
        const read = () => page.evaluate(() => {
          const kept = globalThis as unknown as Record<string, unknown>;
          return { sameTitle: kept.serverTitle === document.querySelector("title"), title: document.title,
            templates: document.querySelectorAll("template[data-component-head]").length,
            preload: document.querySelectorAll('link[rel="preload"][data-component-head]').length,
            scripts: document.querySelectorAll('script[src="https://js.example/sdk.js"]').length,
            runs: (globalThis as unknown as { runs?: Record<string, number> }).runs?.sdk ?? 0,
            loads: document.getElementById("checkout")?.getAttribute("data-loads") ?? null };
        });
        assert.deepEqual(await read(), { sameTitle: true, title: "Checkout · Acme", templates: 0, preload: 1, scripts: 1, runs: 1, loads: "1" });
        // Hydration adopts each instance's block; a value change updates that instance's block in place.
        const json = await page.evaluate(async () => {
          const server = (globalThis as unknown as { serverJson: Element[] }).serverJson;
          const same = () => { const blocks = Array.from(document.querySelectorAll('script[type="application/ld+json"]')); return blocks.length === server.length && blocks.every((block, index) => block === server[index]); };
          const adopted = same();
          (window as unknown as { HtmlNextLive: { updateComponentProps(root: Element, props: object): void } }).HtmlNextLive.updateComponentProps(document.getElementById("product")!, { name: "Hammer" });
          await new Promise((resolve) => setTimeout(resolve, 20));
          return { adopted, same: same(), text: server.map((block) => block.textContent) };
        });
        assert.deepEqual(json, { adopted: true, same: true, text: ['{"name":"Hammer"}', '{"name":"Anvil"}'] });
        // A new connection runs on:load again without inserting or running the script again.
        await page.evaluate(async () => {
          const root = document.getElementById("checkout")!;
          root.remove();
          await new Promise((resolve) => setTimeout(resolve, 20));
          document.querySelector("#mount")!.append(root);
          await new Promise((resolve) => setTimeout(resolve, 20));
        });
        // While the form was away the authored title returned, so a new managed title replaced it again.
        assert.deepEqual(await read(), { sameTitle: false, title: "Checkout · Acme", templates: 0, preload: 1, scripts: 1, runs: 1, loads: "2" });
        // With no component setting a title, the authored node returns: the same object.
        const restored = await page.evaluate(async () => {
          document.querySelector("#mount")!.replaceChildren();
          await new Promise((resolve) => setTimeout(resolve, 20));
          const kept = globalThis as unknown as Record<string, unknown>;
          return { same: kept.authoredTitle === document.querySelector("title"), title: document.title };
        });
        assert.deepEqual(restored, { same: true, title: "Acme" });
        assert.deepEqual(requested, ["sdk.js"]);
        assert.deepEqual(errors, []);
      } finally {
        await browser.close();
      }
    });
  }
});
