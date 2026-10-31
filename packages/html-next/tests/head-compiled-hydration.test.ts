import assert from "node:assert/strict";
import { afterAll, beforeAll, describe, it } from "vitest";

import { chromium, firefox, webkit, type BrowserType } from "playwright";

import { renderComponents } from "../src/server.js";
import { parseComponentResource } from "../src/source-parser.js";
import { compiledFixtures } from "./hydration-fixtures.js";

/**
 * Head declarations through compiled output's hydration (components#head-ssr), in Chromium, Firefox
 * and WebKit: Node output from `renderComponents`, adopted by compiled modules generated with
 * `hydrate: true`, as an application delivers server-rendered pages.
 */
const enabled = process.env.HTMLNEXT_BROWSER_TEST === "1";

const source = `<template component="docs-layout"><defs>
  <title>Docs · Acme</title><meta name="description" content="Acme documentation">
  <link rel="preconnect" href="https://search.acme.example">
</defs><div class="layout"><slot></slot></div></template>
<template component="page-a"><defs>
  <prop name="section" type="string" default="Install">The section.</prop>
  <state name="loads" type="number" value="0"></state>
  <handler name="loaded"><set name="loads" expr:value="$loads + 1"></set></handler>
  <title>{$section} · Docs</title>
  <link rel="canonical" href="https://acme.example/install">
  <link rel="preconnect" href="https://search.acme.example">
  <script type="application/ld+json" from:value="{ name: $section }"></script>
  <script name="sdk" src="https://js.example/sdk.js" crossorigin="anonymous" on:load="loaded"></script>
</defs><article from:data-loads="$loads" from:data-ok="$sdk.ok"><slot></slot></article></template>
<template component="page-b"><defs>
  <title>Configure · Docs</title><link rel="preconnect" href="https://search.acme.example">
</defs><article>B</article></template>
<template component="x-note"><defs><title>Note</title></defs><aside></aside></template>
<template component="x-product"><defs>
  <prop name="section" type="string" default="Install">The section.</prop>
  <script type="application/ld+json" from:value="{ name: $section }"></script>
</defs><section></section></template>
<template component="language-page"><defs>
  <link rel="alternate" hreflang="en" href="https://docs.example/">
  <link rel="alternate" hreflang="x-default" href="https://docs.example/">
</defs><article>Languages</article></template>
<template component="language-peer"><defs><link rel="alternate" hreflang="x-default" href="https://docs.example/"></defs><aside>Peer</aside></template>`;
const definitions = parseComponentResource(source, "https://app.example/app.html").definitions;
// A build reads its components from files, as HTMLKit does.
const widget = parseComponentResource(`<template component="x-widget"><defs>
  <script name="widget" src="/kit/widget.js"></script>
</defs><div from:data-ok="$widget.ok"></div></template>`, "file:///app/widget.html").definitions;
const authoredHead = '<meta charset="utf-8"><title>Acme</title><meta name="description" content="Site">';

describe.skipIf(!enabled)("head declarations through compiled hydration, in every engine", () => {
  let compiled = "";
  let page = "";
  /** Rendered at HTMLKit's default origin, to be served from another. */
  let elsewhere = "";
  let languages = "";

  beforeAll(async () => {
    compiled = await compiledFixtures("iife", 'export { componentRegistry } from "@nextwebwg/html-next/generated-runtime";', [...definitions, ...widget]);
    const rendered = await renderComponents('<docs-layout><page-a id="page"></page-a></docs-layout><x-product></x-product>', { definitions, head: authoredHead, url: "https://app.example/" });
    page = `<!doctype html><head>${rendered.head}</head><body><main id="mount">${rendered.html}</main></body>`;
    const languagePage = await renderComponents('<language-page id="language"></language-page>', { definitions,
      head: '<link rel="alternate" hreflang="EN" href="https://docs.example/">', url: "https://app.example/" });
    languages = `<!doctype html><head>${languagePage.head}</head><body><main id="mount">${languagePage.html}</main></body>`;
    const widgetPage = await renderComponents("<x-widget></x-widget>", { definitions: widget, head: '<meta charset="utf-8">', url: "http://localhost/" });
    elsewhere = `<!doctype html><head>${widgetPage.head}</head><body><main id="mount">${widgetPage.html}</main></body>`;
  });
  afterAll(() => {});

  for (const [engine, browserType] of [["Chromium", chromium], ["Firefox", firefox], ["WebKit", webkit]] as const satisfies ReadonlyArray<readonly [string, BrowserType]>) {
    it(`${engine} hydrates language alternates sharing one URL without merging languages or replacing authored nodes`, async () => {
      const browser = await browserType.launch({ headless: true }); const errors: string[] = [];
      try {
        const tab = await browser.newPage(); tab.on("pageerror", error => errors.push(error.message));
        await tab.route("https://app.example/**", route => route.fulfill({ contentType: "text/html", body: languages }));
        await tab.goto("https://app.example/languages/");
        assert.equal(await tab.locator('head link[rel="alternate"]').count(), 2);
        await tab.evaluate(() => { Object.assign(window, { languageLinks: [...document.head.querySelectorAll('link[rel="alternate"]')] }); });
        await tab.addScriptTag({ content: compiled });
        const result = await tab.evaluate(async () => {
          const kept = window as unknown as { languageLinks: Element[]; HtmlCompiled: { factories: Record<string, (options?: object, html?: undefined, root?: Element) => Element> } };
          const { factories } = kept.HtmlCompiled;
          const settle = () => new Promise(done => setTimeout(done, 0));
          const root = document.getElementById("language")!;
          factories["language-page"]!({}, undefined, root); await settle();
          const read = () => [...document.head.querySelectorAll('link[rel="alternate"]')];
          const hydrated = read().length === 2 && read().every((link, index) => link === kept.languageLinks[index]);
          const peer = factories["language-peer"]!(); document.getElementById("mount")!.append(peer); await settle();
          root.remove(); await settle();
          const shared = read().length === 2 && read()[1] === kept.languageLinks[1];
          peer.remove(); await settle();
          return { hydrated, shared, restored: read().length === 1 && read()[0] === kept.languageLinks[0] };
        });
        assert.deepEqual(result, { hydrated: true, shared: true, restored: true }); assert.deepEqual(errors, []);
      } finally { await browser.close(); }
    });

    it(`${engine} adopts the server's head, inserts the eager script once, and restores the authored title as the same node`, async () => {
      // The server wrote the reconciled head with a preload, never a script.
      assert.match(page, /<title data-component-head="">Install · Docs<\/title><template data-component-head="set-aside"><title>Acme<\/title><\/template>/);
      assert.match(page, /<link rel="preload" as="script" href="https:\/\/js\.example\/sdk\.js" crossorigin="anonymous" data-component-head="">/);
      // Two instances with identical JSON-LD write two blocks.
      assert.match(page, /(<script type="application\/ld\+json" data-component-head="">\{"name":"Install"\}<\/script>){2}/);
      assert.doesNotMatch(page, /<script src/);
      const browser = await browserType.launch({ headless: true });
      const errors: string[] = [];
      try {
        const tab = await browser.newPage();
        tab.setDefaultTimeout(10_000);
        tab.on("pageerror", (error) => errors.push(error.message));
        tab.on("console", (message) => { if (message.type() === "error" && !message.text().startsWith("Failed to preconnect")) errors.push(message.text()); });
        const requested: string[] = [];
        await tab.route(/^https:\/\/(?:app|js)\.example\//, (route) => {
          const url = new URL(route.request().url());
          const headers = { "access-control-allow-origin": "*" };
          if (url.hostname === "js.example") {
            requested.push(url.pathname);
            return route.fulfill({ contentType: "text/javascript", headers, body: "globalThis.runs = (globalThis.runs ?? 0) + 1;" });
          }
          return route.fulfill({ contentType: "text/html; charset=utf-8", headers, body: page });
        });
        await tab.goto("https://app.example/");
        await tab.evaluate(() => {
          const kept = globalThis as unknown as Record<string, unknown>;
          kept.server = Array.from(document.head.querySelectorAll("[data-component-head]:not(template)"));
          kept.authoredTitle = document.querySelector<HTMLTemplateElement>("template[data-component-head]")!.content.firstElementChild;
        });
        await tab.addScriptTag({ content: compiled });
        // The application adopts its server-rendered roots, the page inside its layout first.
        await tab.evaluate(() => {
          const { factories } = (window as unknown as { HtmlCompiled: { factories: Record<string, (options: object, html: undefined, root: Element) => Element> } }).HtmlCompiled;
          factories["page-a"]!({}, undefined, document.querySelector('[component~="page-a"]')!);
          factories["docs-layout"]!({}, undefined, document.querySelector('[component~="docs-layout"]')!);
          factories["x-product"]!({}, undefined, document.querySelector('[component~="x-product"]')!);
        });
        await tab.waitForFunction(() => document.querySelector('[component~="page-a"]')?.getAttribute("data-loads") === "1");
        const read = () => tab.evaluate(() => {
          const kept = globalThis as unknown as Record<string, unknown>;
          const managed = Array.from(document.head.querySelectorAll("[data-component-head]"));
          return {
            title: document.title,
            head: managed.map((element) => element.outerHTML.replace(' data-component-head=""', " *")),
            adopted: (kept.server as Element[]).filter((element) => managed.includes(element)).length,
            runs: (globalThis as unknown as { runs?: number }).runs ?? 0,
            loads: document.querySelector('[component~="page-a"]')?.getAttribute("data-loads") ?? null,
          };
        });
        const hydrated = await read();
        assert.deepEqual(hydrated, {
          title: "Install · Docs",
          head: ["<title *>Install · Docs</title>", '<meta name="description" content="Acme documentation" *>',
            '<link rel="preconnect" href="https://search.acme.example" *>', '<link rel="canonical" href="https://acme.example/install" *>',
            '<script type="application/ld+json" *>{"name":"Install"}</script>', '<script type="application/ld+json" *>{"name":"Install"}</script>',
            '<link rel="preload" as="script" href="https://js.example/sdk.js" crossorigin="anonymous" *>',
            '<script src="https://js.example/sdk.js" crossorigin="anonymous" *></script>'],
          // Every element the server wrote is the same node, and the template is gone.
          adopted: 7, runs: 1, loads: "1",
        });

        // A deeper component takes the title, and gives it back; a binding change updates the same JSON-LD block.
        const updated = await tab.evaluate(async () => {
          const { factories, componentRegistry } = (window as unknown as { HtmlCompiled: { factories: Record<string, (options?: object) => Element>; componentRegistry: { update(element: Element, props: object): void }; } }).HtmlCompiled;
          const settle = () => new Promise((done) => setTimeout(done, 20));
          const pageRoot = document.querySelector('[component~="page-a"]')!;
          const blocks = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
          const note = factories["x-note"]!();
          pageRoot.append(note);
          await settle();
          const deeper = document.title;
          note.remove();
          await settle();
          const back = document.title;
          componentRegistry.update(pageRoot, { section: "Upgrade" });
          await settle();
          const after = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
          // Each instance's block is its own: the page's changes in place, as the same node; the product's stays.
          return { deeper, back, title: document.title, json: after.map((block) => block.textContent),
            same: after.length === blocks.length && after.every((block, index) => block === blocks[index]) };
        });
        assert.deepEqual(updated, { deeper: "Note", back: "Install · Docs", title: "Upgrade · Docs", json: ['{"name":"Upgrade"}', '{"name":"Install"}'], same: true });

        // A client navigation is one reconciliation: no intermediate title, and the shared preconnect stays.
        const navigation = await tab.evaluate(async () => {
          const { factories } = (window as unknown as { HtmlCompiled: { factories: Record<string, (options?: object) => Element> } }).HtmlCompiled;
          const seen: string[] = [];
          const removed: Node[] = [];
          const preconnect = document.querySelector('link[rel="preconnect"]');
          const observer = new MutationObserver((records) => { seen.push(document.title); for (const record of records) removed.push(...record.removedNodes); });
          observer.observe(document.head, { subtree: true, childList: true, characterData: true, attributes: true });
          document.querySelector('[component~="page-a"]')!.replaceWith(factories["page-b"]!());
          await new Promise((done) => setTimeout(done, 20));
          observer.disconnect();
          return { seen: [...new Set(seen)], kept: preconnect === document.querySelector('link[rel="preconnect"]') && !removed.includes(preconnect!),
            canonical: document.querySelectorAll('link[rel="canonical"]').length };
        });
        assert.deepEqual(navigation, { seen: ["Configure · Docs"], kept: true, canonical: 0 });

        // With no component left, the authored title and description return; the script stays.
        const restored = await tab.evaluate(async () => {
          document.querySelector("#mount")!.replaceChildren();
          await new Promise((done) => setTimeout(done, 20));
          const kept = globalThis as unknown as Record<string, unknown>;
          return { same: kept.authoredTitle === document.querySelector("title"), title: document.title,
            description: document.querySelector('meta[name="description"]')!.getAttribute("content"),
            scripts: document.querySelectorAll('script[src="https://js.example/sdk.js"]').length };
        });
        assert.deepEqual(restored, { same: true, title: "Acme", description: "Site", scripts: 1 });
        assert.deepEqual(requested, ["/sdk.js"]);
        assert.deepEqual(errors, []);
      } finally {
        await browser.close();
      }
    });

    it(`${engine} preloads a same-origin script by its path, wherever the page is served`, async () => {
      // Rendered at http://localhost, the preload names no origin.
      assert.match(elsewhere, /<link rel="preload" as="script" href="\/kit\/widget\.js" data-component-head="">/);
      const browser = await browserType.launch({ headless: true });
      const errors: string[] = [];
      try {
        const tab = await browser.newPage();
        tab.setDefaultTimeout(10_000);
        tab.on("pageerror", (error) => errors.push(error.message));
        const requested: string[] = [];
        await tab.route(/^https:\/\/app\.example\//, (route) => {
          const url = new URL(route.request().url());
          if (url.pathname === "/kit/widget.js") {
            requested.push(url.pathname);
            return route.fulfill({ contentType: "text/javascript", body: "globalThis.widgetRuns = (globalThis.widgetRuns ?? 0) + 1;" });
          }
          // A same-origin script policy, which blocks a preload or script from any other origin.
          return route.fulfill({ contentType: "text/html; charset=utf-8", body: elsewhere,
            headers: { "content-security-policy": "script-src 'self' 'unsafe-inline'" } });
        });
        await tab.goto("https://app.example/");
        await tab.evaluate(() => {
          const kept = globalThis as unknown as Record<string, unknown>;
          kept.blocked = [];
          document.addEventListener("securitypolicyviolation", (event) => (kept.blocked as string[]).push(event.blockedURI));
          kept.preload = document.querySelector('link[rel="preload"]');
        });
        await tab.addScriptTag({ content: compiled });
        await tab.evaluate(() => {
          const { factories } = (window as unknown as { HtmlCompiled: { factories: Record<string, (options: object, html: undefined, root: Element) => Element> } }).HtmlCompiled;
          factories["x-widget"]!({}, undefined, document.querySelector('[component~="x-widget"]')!);
        });
        await tab.waitForFunction(() => document.querySelector('[component~="x-widget"]')?.hasAttribute("data-ok") === true);
        const result = await tab.evaluate(() => {
          const kept = globalThis as unknown as Record<string, unknown>;
          return { preload: (kept.preload as HTMLLinkElement).href, kept: kept.preload === document.querySelector('link[rel="preload"]'),
            scripts: Array.from(document.querySelectorAll("script[src]"), (script) => (script as HTMLScriptElement).src),
            runs: (globalThis as unknown as { widgetRuns?: number }).widgetRuns ?? 0, blocked: kept.blocked };
        });
        // The inserted script and its preload are the served origin's, so the script entry owns the preload.
        assert.deepEqual(result, { preload: "https://app.example/kit/widget.js", kept: true, scripts: ["https://app.example/kit/widget.js"], runs: 1, blocked: [] });
        assert.deepEqual(requested, ["/kit/widget.js"]);
        assert.deepEqual(errors, []);
      } finally {
        await browser.close();
      }
    });
  }
});
