import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { chromium, firefox, webkit } from "playwright";
import { afterAll, beforeAll, describe, it } from "vitest";
import { parseComponentResource } from "../src/source-parser.js";
import { attributeForwardingHotFiles } from "./attribute-forwarding-hot.js";
import { renderComponents } from "../src/server.js";

const source = `<template component="x-before"><button $attributes title="Template">Before</button></template>
  <template component="x-after"><button title="Template" $attributes>After</button></template>
  <template component="x-inner"><section><button $attributes>Inner</button></section></template>
  <template component="x-none"><button>None</button></template>
  <template component="x-consumed"><defs><prop name="title" type="string">Title.</prop></defs><button $attributes>{$title}</button></template>
  <template component="x-future"><defs><state name="forward" type="boolean" value="false"></state></defs><article><button $if="$forward" $attributes>Future</button><i $if="not $forward">Hidden</i></article></template>
  <template component="x-bound-before"><defs><state name="local" type="string" value="Local"></state></defs><button from:title="$local" $attributes>Bound before</button></template>
  <template component="x-bound-after"><defs><state name="local" type="string" value="Local"></state></defs><button $attributes from:title="$local">Bound after</button></template>
  <template component="x-page"><defs><state name="caller" type="string" from="'Caller'"></state></defs><main>
    <div data-case="before"><x-before from:title="$caller"></x-before></div>
    <div data-case="after"><x-after from:title="$caller"></x-after></div>
    <div data-case="inner"><x-inner from:title="$caller"></x-inner></div>
    <div data-case="none"><x-none from:title="$caller"></x-none></div>
    <div data-case="consumed"><x-consumed from:title="$caller"></x-consumed></div>
    <div data-case="bound-before"><x-bound-before from:title="$caller"></x-bound-before></div>
    <div data-case="bound-after"><x-bound-after from:title="$caller"></x-bound-after></div>
    <div data-case="future"><x-future from:title="$caller"></x-future></div>
  </main></template>`;

describe.skipIf(process.env.HTMLNEXT_BROWSER_TEST !== "1")("ordered explicit attribute forwarding", () => {
  let directory: string, bundle: string;
  let hotFiles: Record<string, string>;
  beforeAll(async () => {
    hotFiles = await attributeForwardingHotFiles();
    directory = await mkdtemp(join(tmpdir(), "html-next-attributes-"));
    bundle = join(directory, "runtime.js");
    await build({ entryPoints: [new URL("../src/live.ts", import.meta.url).pathname], bundle: true, format: "iife", globalName: "HtmlRuntime", outfile: bundle, platform: "browser", target: ["es2022"] });
  });
  afterAll(async () => { await rm(directory, { recursive: true, force: true }); });

  for (const [engine, type] of [["Chromium", chromium], ["Firefox", firefox], ["WebKit", webkit]] as const) {
    it(`${engine} retains caller inputs across compiled hot replacement and marker changes`, async () => {
      const browser = await type.launch();
      try {
        const page = await browser.newPage();
        const errors: string[] = [];
        page.on("pageerror", error => errors.push(error.message));
        await page.route("https://attributes-hot.example/**", route => {
          const path = new URL(route.request().url()).pathname;
          return route.fulfill({ contentType: path === "/" ? "text/html" : "text/javascript", body: path === "/" ? "<!doctype html><body></body>" : hotFiles[path] ?? "" });
        });
        await page.goto("https://attributes-hot.example/");
        const snapshots = await page.evaluate("import('/scenario.js').then(module => module.run())");
        assert.deepEqual(snapshots, [
          { tag: "button", title: "Template", note: null, prototype: null, page: null, className: null },
          { tag: "article", title: "Template", note: "Note", prototype: "Prototype", page: "Page", className: "page-owned" },
          { tag: "section", title: "Caller", note: "Note", prototype: "Prototype", page: "Page", className: "page-owned" },
          { tag: "section", title: "Changed", note: "Changed", prototype: "Prototype", page: "Page", className: "page-owned" },
          { tag: "aside", title: "Final", note: null, prototype: null, page: "Page", className: "page-owned" },
          { tag: "aside", title: "Final", note: null, prototype: null, page: "Page", className: "page-owned" },
          { tag: "footer", title: "Changed", note: "Later", prototype: "Prototype", page: "Page", className: "page-owned" },
        ]);
        assert.deepEqual(errors, []);
      } finally { await browser.close(); }
    });
    for (const hydrate of [false, true]) it(`${engine} carries page writes without leaking forwarded inputs across root choices (${hydrate ? "hydrated" : "fresh"})`, async () => {
      const source = `<template component="x-choice"><defs><state name="alternate" type="boolean" value="false"></state></defs><template $match><section $when="$alternate" class="own" style="display: block">Other</section><button $else $attributes>Initial</button></template></template>`;
      const definitions = parseComponentResource(source, "attribute-root-choice.html").definitions;
      const invocation = '<x-choice title="Caller" class="caller" style="color: red"></x-choice>';
      const html = hydrate ? (await renderComponents(invocation, { definitions })).html : source + invocation;
      const browser = await type.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent(html);
        await page.addScriptTag({ path: bundle });
        await page.evaluate(definitions => {
          const api = (window as any).HtmlRuntime;
          if (definitions !== undefined) api.registerComponentDefinitions(JSON.parse(definitions));
          api.observeDocument(document);
        }, hydrate ? JSON.stringify(definitions) : undefined);
        const settle = () => page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        await settle();
        await page.evaluate(() => {
          const root = document.querySelector('button')!;
          root.setAttribute('data-page', 'Page');
          root.classList.add('page');
          root.style.borderTopWidth = '2px';
          (window as any).choiceHost = (window as any).HtmlRuntime.getComponentHost(root);
          (window as any).choiceHost.state.alternate = true;
        });
        await settle();
        assert.deepEqual(await page.evaluate(() => {
          const root = document.querySelector('section')!;
          return [root.getAttribute('title'), root.getAttribute('data-page'), [...root.classList].sort(), root.style.color, root.style.display, root.style.borderTopWidth];
        }), [null, 'Page', ['own', 'page'], '', 'block', '2px']);
        await page.evaluate(() => { (window as any).choiceHost.state.alternate = false; });
        await settle();
        assert.equal(await page.locator('button').getAttribute('title'), 'Caller');
        assert.equal(await page.locator('button').getAttribute('data-page'), 'Page');
      } finally { await browser.close(); }
    });
    for (const hydrate of [false, true]) it(`${engine} preserves precedence, destinations and future inputs (${hydrate ? "hydrated" : "fresh"})`, async () => {
      const definitions = parseComponentResource(source, "attribute-forwarding-browser.html").definitions;
      const html = hydrate ? (await renderComponents("<x-page></x-page>", { definitions })).html : source + "<x-page></x-page>";
      const browser = await type.launch({ headless: true });
      try {
        const page = await browser.newPage();
        const errors: string[] = [];
        page.on("pageerror", error => errors.push(error.message));
        await page.setContent(html);
        await page.addScriptTag({ path: bundle });
        await page.evaluate(definitions => {
          const api = (window as any).HtmlRuntime;
          if (definitions !== undefined) api.registerComponentDefinitions(JSON.parse(definitions));
          api.observeDocument(document);
        }, hydrate ? JSON.stringify(definitions) : undefined);
        const settle = () => page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        const snapshot = () => page.evaluate(() => {
          const get = (caseName: string, selector: string) => document.querySelector(`[data-case="${caseName}"] ${selector}`);
          return {
            before: get("before", "button")?.getAttribute("title"),
            after: get("after", "button")?.getAttribute("title"),
            innerRoot: get("inner", "section")?.getAttribute("title"),
            inner: get("inner", "button")?.getAttribute("title"),
            none: get("none", "button")?.getAttribute("title"),
            consumedTitle: get("consumed", "button")?.getAttribute("title"),
            consumedText: get("consumed", "button")?.textContent,
            futureRoot: get("future", "article")?.getAttribute("title"),
          };
        });
        const expected = (caller: string) => ({ before: "Template", after: caller, innerRoot: null, inner: caller, none: null, consumedTitle: null, consumedText: caller, futureRoot: null });
        await settle();
        assert.deepEqual(await snapshot(), expected("Caller"));
        await page.evaluate(() => { (window as any).HtmlRuntime.getComponentHost(document.querySelector("main")).state.caller = "Updated"; });
        await settle();
        assert.deepEqual(await snapshot(), expected("Updated"));
        await page.evaluate(() => { (window as any).HtmlRuntime.getComponentHost(document.querySelector('[data-case="future"] article')).state.forward = true; });
        await settle();
        assert.equal(await page.locator('[data-case="future"] button').getAttribute("title"), "Updated");
        assert.deepEqual(await snapshot(), expected("Updated"));
        const bound = () => page.evaluate(() => ["bound-before", "bound-after"].map(name => document.querySelector(`[data-case="${name}"] button`)?.getAttribute("title")));
        assert.deepEqual(await bound(), ["Updated", "Local"]);
        await page.evaluate(() => {
          for (const name of ["bound-before", "bound-after"]) (window as any).HtmlRuntime.getComponentHost(document.querySelector(`[data-case="${name}"] button`)).state.local = "Changed";
        });
        await settle();
        assert.deepEqual(await bound(), ["Updated", "Changed"]);
        await page.evaluate(() => { (window as any).HtmlRuntime.getComponentHost(document.querySelector("main")).state.caller = null; });
        await settle();
        assert.equal(await page.locator('[data-case="after"] button').getAttribute("title"), "Template");
        assert.equal(await page.locator('[data-case="inner"] button').getAttribute("title"), null);
        assert.deepEqual(await bound(), ["Changed", "Changed"]);
        assert.deepEqual(errors, []);
      } finally { await browser.close(); }
    });
  }
});
