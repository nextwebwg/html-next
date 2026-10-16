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
