import assert from "node:assert/strict";
import { afterEach, describe, it, vi } from "vitest";

import { JSDOM } from "jsdom";

import { parseComponent } from "../src/source-parser.js";

/**
 * Head declarations in the live runtime (https://nextwebwg.org/declarative-components/components#head-management),
 * in jsdom. head-conformance.test.ts runs the same behavior in Chromium, Firefox and WebKit.
 */
async function page(head: string, definitions: readonly string[]) {
  const { window } = new JSDOM(`<!doctype html><head>${head}</head><body><main></main></body>`, { url: "https://acme.example/docs/" });
  for (const key of Object.getOwnPropertyNames(window)) {
    if (key in globalThis && !["Event", "CustomEvent", "EventTarget", "document", "Node", "Element"].includes(key)) continue;
    try { vi.stubGlobal(key, (window as unknown as Record<string, unknown>)[key]); } catch { /* read-only global */ }
  }
  const runtime = await import("../src/runtime.js");
  const document = window.document;
  runtime.registerComponentDefinitions(definitions.map((source, index) => parseComponent(source, `https://acme.example/c${index}.html`)), document);
  runtime.observeDocument(document);
  const main = document.querySelector("main")!;
  return {
    document,
    runtime,
    main,
    /** Lets mutation records, reactive flushes and reconciliation run. */
    settle: () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
    /** The head, one element per line, the marker shown as `*`. */
    head: () => Array.from(document.head.children, (element) => element.outerHTML.replace(' data-component-head=""', " *")),
  };
}

const layout = `<template component="docs-layout"><defs>
  <title>Docs · Acme</title><meta name="description" content="Acme documentation">
  <meta property="og:image" content="/layout.png"><meta property="og:image:alt" content="Acme">
  <link rel="preconnect" href="https://search.acme.example">
</defs><div class="layout"><slot></slot></div></template>`;
const pageA = `<template component="page-a"><defs>
  <prop name="section" type="string" default="Install">The section.</prop>
  <title>{$section} · Docs</title>
  <meta property="og:image" content="/a-1.png"><meta property="og:image:width" content="1200"><meta property="og:image" content="/a-2.png">
  <link rel="preconnect" href="https://search.acme.example">
</defs><article from:data-section="$section">A</article></template>`;
const pageB = `<template component="page-b"><defs>
  <title>Configure · Docs</title><meta property="og:image:width" content="5">
  <link rel="preconnect" href="https://search.acme.example">
</defs><article>B</article></template>`;
const card = `<template component="img-card"><defs>
  <link rel="preconnect" href="https://img.acme.example"><link rel="dns-prefetch" href="//cdn.acme.example">
</defs><figure></figure></template>`;
const note = `<template component="x-note"><defs><title>Note</title></defs><aside></aside></template>`;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("head declarations in the live runtime", () => {
  it("adds marked elements on connect, removes them on disconnect, and restores the authored head as the same nodes", async () => {
    const { document, main, settle, head } = await page('<meta charset="utf-8"><title>Acme</title><meta name="description" content="Site">', [layout]);
    const authoredTitle = document.querySelector("title");
    const authoredDescription = document.querySelector('meta[name="description"]');
    // Registering a definition changes nothing in the document.
    assert.deepEqual(head(), ['<meta charset="utf-8">', "<title>Acme</title>", '<meta name="description" content="Site">']);
    main.innerHTML = "<docs-layout></docs-layout>";
    await settle();
    assert.deepEqual(head(), ['<meta charset="utf-8">', "<title *>Docs · Acme</title>", '<meta name="description" content="Acme documentation" *>',
      '<meta property="og:image" content="/layout.png" *>', '<meta property="og:image:alt" content="Acme" *>',
      '<link rel="preconnect" href="https://search.acme.example" *>']);
    assert.equal(document.title, "Docs · Acme");
    assert.equal(authoredTitle!.isConnected, false);
    main.replaceChildren();
    await settle();
    assert.deepEqual(head(), ['<meta charset="utf-8">', "<title>Acme</title>", '<meta name="description" content="Site">']);
    assert.equal(document.querySelector("title"), authoredTitle);
    assert.equal(document.querySelector('meta[name="description"]'), authoredDescription);
  });

  it("shares one element per shared key, reference counted, and never removes an authored one", async () => {
    const { main, settle, head } = await page('<link rel="dns-prefetch" href="https://cdn.acme.example/">', [card]);
    main.innerHTML = "<img-card id='one'></img-card><img-card id='two'></img-card>";
    await settle();
    // `//cdn.acme.example` resolves to the authored link's URL, so the authored element satisfies it.
    assert.deepEqual(head(), ['<link rel="dns-prefetch" href="https://cdn.acme.example/">', '<link rel="preconnect" href="https://img.acme.example" *>']);
    const link = main.ownerDocument.querySelector('link[rel="preconnect"]');
    main.querySelector("#one")!.remove();
    await settle();
    assert.equal(main.ownerDocument.querySelector('link[rel="preconnect"]'), link, "the element stays while a contributor remains");
    main.querySelector("#two")!.remove();
    await settle();
    assert.deepEqual(head(), ['<link rel="dns-prefetch" href="https://cdn.acme.example/">']);
  });

  it("gives a competing key to the deepest instance, then the latest at one depth, updating the winner's element in place", async () => {
    const { document, main, settle, head, runtime } = await page("<title>Acme</title>", [layout, pageA, pageB, note]);
    main.innerHTML = "<docs-layout><page-a></page-a></docs-layout>";
    await settle();
    const title = document.querySelector("title")!;
    assert.equal(document.title, "Install · Docs");
    // A bound title updates the same element.
    runtime.updateComponentProps(main.querySelector("[data-component~=page-a]")!, { section: "Upgrade" });
    await settle();
    assert.equal(document.title, "Upgrade · Docs");
    assert.equal(document.querySelector("title"), title);
    // Deeper wins: a note inside the page takes the title; at one depth, the later connection does.
    main.querySelector("article")!.append(document.createElement("x-note"));
    await settle();
    assert.equal(document.title, "Note");
    main.querySelector("[data-component~=layout], .layout")!.append(document.createElement("page-b"));
    await settle();
    assert.equal(document.title, "Note");
    main.querySelector("[data-component~=x-note]")!.remove();
    await settle();
    assert.equal(document.title, "Configure · Docs");
    main.querySelector("[data-component~=page-b]")!.remove();
    await settle();
    assert.equal(document.title, "Upgrade · Docs");
    assert.equal(document.querySelector("title"), title, "every change reused the managed element");
    main.replaceChildren();
    await settle();
    assert.deepEqual(head(), ["<title>Acme</title>"]);
  });

  it("keeps a winner's meta list and its sub-properties together, and never mixes lists across components", async () => {
    const { main, settle, head } = await page("", [layout, pageA, pageB]);
    main.innerHTML = "<docs-layout><page-a></page-a></docs-layout>";
    await settle();
    const images = head().filter((line) => line.includes('property="og:image'));
    assert.deepEqual(images, ['<meta property="og:image" content="/a-1.png" *>', '<meta property="og:image:width" content="1200" *>',
      '<meta property="og:image" content="/a-2.png" *>']);
    // page-b declares og:image:width without og:image: it never describes the layout's image.
    main.querySelector("[data-component~=page-a]")!.replaceWith(main.ownerDocument.createElement("page-b"));
    await settle();
    assert.deepEqual(head().filter((line) => line.includes('property="og:image')), ['<meta property="og:image" content="/layout.png" *>',
      '<meta property="og:image:alt" content="Acme" *>']);
  });

  it("applies a page change as one reconciliation: no intermediate title, and shared elements stay in place", async () => {
    const { document, main, settle } = await page("<title>Acme</title>", [layout, pageA, pageB]);
    main.innerHTML = "<docs-layout><page-a></page-a></docs-layout>";
    await settle();
    const preconnect = document.querySelector('link[rel="preconnect"]');
    const titles: string[] = [];
    const removed: Node[] = [];
    new document.defaultView!.MutationObserver((records) => {
      titles.push(document.title);
      for (const record of records) removed.push(...record.removedNodes);
    }).observe(document.head, { subtree: true, childList: true, characterData: true, attributes: true });
    main.querySelector("[data-component~=page-a]")!.replaceWith(document.createElement("page-b"));
    await settle();
    assert.deepEqual(titles, ["Configure · Docs"]);
    assert.equal(document.querySelector('link[rel="preconnect"]'), preconnect);
    assert.equal(removed.includes(preconnect!), false);
  });

  it("writes literal JSON-LD unchanged and a bound value as JSON with every < escaped, omitting it for null", async () => {
    const product = `<template component="x-product"><defs>
      <state name="schema" type="unknown"></state>
      <script type="application/ld+json">{"@type": "Organization", "name": "{Acme}"}</script>
      <script type="application/ld+json" from:value="$schema"></script>
    </defs><section></section></template>`;
    const { document, main, settle, head, runtime } = await page("", [product]);
    main.innerHTML = "<x-product></x-product>";
    await settle();
    assert.deepEqual(head(), ['<script type="application/ld+json" *>{"@type": "Organization", "name": "{Acme}"}</script>']);
    const host = runtime.getComponentHost(main.firstElementChild!)!;
    host.state.schema = { "@type": "Product", name: "</script><script>alert(1)</script><!--" };
    await settle();
    const bound = document.querySelectorAll('script[type="application/ld+json"]')[1]!;
    assert.equal(bound.textContent, '{"@type":"Product","name":"\\u003c/script>\\u003cscript>alert(1)\\u003c/script>\\u003c!--"}');
    assert.deepEqual(JSON.parse(bound.textContent!), { "@type": "Product", name: "</script><script>alert(1)</script><!--" });
    // A string is an invalid result: the last value stays.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    host.state.schema = "text";
    await settle();
    assert.equal(document.querySelectorAll('script[type="application/ld+json"]').length, 2);
    assert.match(String(warn.mock.calls[0]?.[0]), /HR007: JSON-LD `\$schema` must be an object or a list/);
    host.state.schema = null;
    await settle();
    assert.equal(document.querySelectorAll('script[type="application/ld+json"]').length, 1);
  });

  it("orders new elements by their instances' tree order, then declared order", async () => {
    const first = `<template component="x-first"><defs><link rel="prefetch" href="/1a"><link rel="prefetch" href="/1b"></defs><i></i></template>`;
    const second = `<template component="x-second"><defs><link rel="prefetch" href="/2"></defs><b></b></template>`;
    const { document, main, settle, head } = await page("", [first, second]);
    main.innerHTML = "<x-second></x-second>";
    await settle();
    main.prepend(document.createElement("x-first"));
    main.append(document.createElement("x-first"));
    await settle();
    assert.deepEqual(head(), ['<link rel="prefetch" href="/2" *>', '<link rel="prefetch" href="/1a" *>', '<link rel="prefetch" href="/1b" *>']);
  });
});

describe("server output of head declarations", () => {
  it("writes the reconciled head, set-aside elements in a template, and a preload for each eager script only", async () => {
    const { renderComponents } = await import("../src/server.js");
    const checkout = parseComponent(`<template component="page-checkout"><defs>
      <title>Checkout · Acme</title><link rel="preconnect" href="https://js.stripe.com">
      <script name="stripe" src="https://js.stripe.com/v3/" crossorigin="anonymous" integrity="sha384-abc"></script>
      <script src="https://maps.example/sdk.js" type="module"></script>
      <script name="later" src="https://lazy.example/a.js" loading="lazy"></script>
      <script name="manual" src="https://manual.example/a.js" loading="manual"></script>
      <script src="https://authored.example/a.js"></script>
    </defs><main>Pay</main></template>`, "https://acme.example/checkout.html");
    const rendered = await renderComponents("<page-checkout></page-checkout><page-checkout></page-checkout>", { definitions: [checkout],
      head: '<meta charset="utf-8"><title>Acme</title><script src="https://authored.example/a.js"></script>', url: "https://acme.example/checkout/" });
    assert.equal(rendered.head, '<meta charset="utf-8">' +
      '<title data-component-head="">Checkout · Acme</title><template data-component-head="set-aside"><title>Acme</title></template>' +
      '<script src="https://authored.example/a.js"></script><link rel="preconnect" href="https://js.stripe.com" data-component-head="">' +
      '<link rel="preload" as="script" href="https://js.stripe.com/v3/" crossorigin="anonymous" integrity="sha384-abc" data-component-head="">' +
      '<link rel="modulepreload" href="https://maps.example/sdk.js" data-component-head="">');
    assert.doesNotMatch(rendered.html, /<script/);
  });

  it("writes a same-origin script's preload as a path, and another origin's as its URL", async () => {
    const { renderComponents } = await import("../src/server.js");
    const page = parseComponent(`<template component="x-page"><defs>
      <script src="/kit/widget.js?v=2"></script><script src="./local.js" type="module"></script>
      <script src="https://js.example/sdk.js"></script><link rel="preconnect" href="/api/">
    </defs><main>Page</main></template>`, "file:///app/x-page.html");
    for (const url of [undefined, "http://localhost/docs/"]) {
      const rendered = await renderComponents("<x-page></x-page>", { definitions: [page], ...(url === undefined ? {} : { url }) });
      assert.equal(rendered.head, '<link rel="preconnect" href="/api/" data-component-head="">' +
        '<link rel="preload" as="script" href="/kit/widget.js?v=2" data-component-head="">' +
        `<link rel="modulepreload" href="${url === undefined ? "/local.js" : "/docs/local.js"}" data-component-head="">` +
        '<link rel="preload" as="script" href="https://js.example/sdk.js" data-component-head="">');
    }
  });
});

// jsdom loads no scripts, so these tests fire the inserted element's load and error events themselves.
const payments = (tag: string, attributes = "") => `<template component="${tag}"><defs>
  <state name="loads" type="number" value="0"></state><state name="errors" type="number" value="0"></state>
  <handler name="loaded"><set name="loads" expr:value="$loads + 1"></set></handler>
  <handler name="failed"><set name="errors" expr:value="$errors + 1"></set></handler>
  <script name="stripe" src="https://js.stripe.com/v3/" ${attributes} on:load="loaded" on:error="failed"></script>
</defs><form from:data-pending="$stripe.pending" from:data-ok="$stripe.ok" from:data-loads="$loads" from:data-errors="$errors"></form></template>`;

describe("declared scripts in the live runtime", () => {
  it("inserts one ordinary script per URL, runs each connection's on:load once it loads, and never removes it", async () => {
    const { document, main, settle, runtime } = await page("", [payments("saved-cards", 'integrity="sha384-abc" crossorigin referrerpolicy="no-referrer" fetchpriority="high"'),
      payments("checkout-form", 'integrity="sha384-abc" crossorigin="anonymous" referrerpolicy="no-referrer" loading="lazy"')]);
    main.innerHTML = "<saved-cards></saved-cards><checkout-form></checkout-form>";
    await settle();
    const scripts = document.querySelectorAll("script");
    assert.equal(scripts.length, 1);
    assert.equal(scripts[0]!.outerHTML, '<script src="https://js.stripe.com/v3/" integrity="sha384-abc" crossorigin="" referrerpolicy="no-referrer" fetchpriority="high" data-component-head=""></script>');
    const [cards, form] = Array.from(main.children);
    assert.deepEqual([cards!.getAttribute("data-pending"), form!.getAttribute("data-pending")], ["", ""]);
    const host = runtime.getComponentHost(form!)!;
    let ready = false;
    void host.scripts.stripe!.ready.then(() => { ready = true; });
    scripts[0]!.dispatchEvent(new Event("load"));
    await settle();
    assert.equal(ready, true);
    assert.deepEqual([cards!.getAttribute("data-loads"), form!.getAttribute("data-loads"), form!.getAttribute("data-ok"), form!.hasAttribute("data-pending")], ["1", "1", "", false]);
    // A new connection runs its handler again, straight away; the script is neither inserted nor run again.
    form!.remove();
    await settle();
    main.append(form!);
    await settle();
    assert.equal(form!.getAttribute("data-loads"), "2");
    main.replaceChildren();
    await settle();
    assert.equal(document.querySelectorAll("script").length, 1);
    assert.equal(host.scripts.stripe!.ok, true);
  });

  it("gives a connection that ends before the script settles no handler, and the next one its own", async () => {
    const { document, main, settle } = await page("", [payments("checkout-form")]);
    main.innerHTML = "<checkout-form></checkout-form>";
    await settle();
    const form = main.firstElementChild!;
    form.remove();
    await settle();
    document.querySelector("script")!.dispatchEvent(new Event("error"));
    await settle();
    assert.equal(form.getAttribute("data-errors"), "0", "nothing runs while disconnected");
    main.append(form);
    await settle();
    assert.equal(form.getAttribute("data-errors"), "1");
    assert.equal(form.getAttribute("data-loads"), "0");
  });

  it("inserts a manual script only when its controller calls load()", async () => {
    const { document, main, settle, runtime } = await page("", [payments("map-view", 'loading="manual"')]);
    main.innerHTML = "<map-view></map-view>";
    await settle();
    assert.equal(document.querySelectorAll("script").length, 0);
    const scripts = runtime.getComponentHost(main.firstElementChild!)!.scripts;
    assert.deepEqual([scripts.stripe!.pending, scripts.stripe!.ok, scripts.stripe!.error], [false, false, null]);
    const ready = scripts.stripe!.load();
    assert.equal(scripts.stripe!.load(), ready);
    await settle();
    assert.equal(document.querySelectorAll("script").length, 1);
    assert.equal(scripts.stripe!.pending, true);
  });

  it("fails a declaration that disagrees on integrity, crossorigin or referrerpolicy, for that instance only", async () => {
    const { document, main, settle, runtime } = await page("", [payments("saved-cards", 'integrity="sha384-abc"'), payments("checkout-form", 'integrity="sha384-other"')]);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    main.innerHTML = "<saved-cards></saved-cards><checkout-form></checkout-form>";
    await settle();
    const [cards, form] = Array.from(main.children);
    const scripts = runtime.getComponentHost(form!)!.scripts;
    assert.ok(scripts.stripe!.error instanceof TypeError);
    await assert.rejects(scripts.stripe!.ready, TypeError);
    assert.equal(form!.getAttribute("data-errors"), "1");
    assert.match(String(errors.mock.calls[0]?.[0]), /HR011: Script `https:\/\/js\.stripe\.com\/v3\/` is declared with different/);
    document.querySelector("script")!.dispatchEvent(new Event("load"));
    await settle();
    assert.deepEqual([cards!.getAttribute("data-loads"), form!.getAttribute("data-loads")], ["1", "0"]);
  });

  it("puts the nonce of the import that reached a definition on the scripts it inserts", async () => {
    const definition = parseComponent(payments("checkout-form"), "https://acme.example/checkout.html");
    const { document, main, settle, runtime } = await page("", []);
    runtime.setDefinitionNonce(definition, "r4nd0m");
    runtime.registerComponentDefinitions([definition], document);
    main.innerHTML = "<checkout-form></checkout-form>";
    await settle();
    assert.equal((document.querySelector("script") as HTMLScriptElement).nonce, "r4nd0m");
  });

  it("shares an authored script with the same URL instead of inserting another", async () => {
    const { document, main, settle } = await page('<script src="https://js.stripe.com/v3/"></script>', [payments("checkout-form")]);
    main.innerHTML = "<checkout-form></checkout-form>";
    await settle();
    assert.equal(document.querySelectorAll("script").length, 1);
    // A parser-inserted classic script without async or defer has run.
    assert.equal(main.firstElementChild!.getAttribute("data-loads"), "1");
  });

  it("resolves a bare script name through the document's import map, and reports one it does not map", async () => {
    const maps = `<template component="map-view"><defs><script name="sdk" src="@acme/maps/v2.js"></script><script name="missing" src="@acme/other.js"></script></defs><div></div></template>`;
    const { document, main, settle, runtime } = await page('<script type="importmap">{"imports": {"@acme/maps/": "/vendor/maps/"}}</script>', [maps]);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    main.innerHTML = "<map-view></map-view>";
    await settle();
    assert.deepEqual(Array.from(document.querySelectorAll("script[src]"), (script) => (script as HTMLScriptElement).src), ["https://acme.example/vendor/maps/v2.js"]);
    assert.ok(runtime.getComponentHost(main.firstElementChild!)!.scripts.missing!.error instanceof TypeError);
    assert.match(String(errors.mock.calls[0]?.[0]), /HR012/);
  });
});
