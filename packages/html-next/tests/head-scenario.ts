import type { Page } from "playwright";

/**
 * One head-declaration scenario (https://nextwebwg.org/declarative-components/components#head-management)
 * for every implementation. A page exposes `globalThis.app`, which renders the components below in
 * its own way: the live runtime from component links, or a compiled or converted entry. Each step
 * acts through `app` and returns what the document head then holds.
 */
export const headFiles: Readonly<Record<string, string>> = {
  "app.html": `<template component="docs-layout"><defs>
  <title>Docs · Acme</title><meta name="description" content="Acme documentation">
  <meta property="og:image" content="/layout.png"><meta property="og:image:alt" content="Acme">
  <link rel="preconnect" href="https://search.acme.example">
</defs><div class="layout"><slot></slot></div></template>
<template component="page-a"><defs>
  <prop name="section" type="string" default="Install">The section.</prop>
  <title>{$section} · Docs</title>
  <meta property="og:image" content="/a-1.png"><meta property="og:image:width" content="1200"><meta property="og:image" content="/a-2.png">
  <link rel="preconnect" href="https://search.acme.example">
  <link rel="canonical" href="https://acme.example/install"><meta name="robots" content="noindex">
</defs><article class="page" from:data-section="$section"><slot></slot></article></template>
<template component="page-b"><defs>
  <title>Configure · Docs</title><meta property="og:image:width" content="5">
  <link rel="preconnect" href="https://search.acme.example">
</defs><article class="page">B</article></template>
<template component="img-card"><defs>
  <link rel="preconnect" href="https://img.acme.example"><link rel="dns-prefetch" href="https://cdn.acme.example">
</defs><figure></figure></template>
<template component="x-note"><defs><title>Note</title></defs><aside></aside></template>
<template component="x-product"><defs>
  <prop name="schema" type="object" open>Structured data.</prop>
  <script type="application/ld+json">{"@type": "Organization", "name": "{Acme}"}</script>
  <script type="application/ld+json" from:value="$schema"></script>
</defs><section from:data-schema="$schema"></section></template>`,
  // Reached through a bare specifier, so its document-authority entries are ignored.
  "widget.html": `<template component="vendor-widget"><defs>
  <link rel="canonical" href="https://vendor.example/"><meta name="theme-color" content="red">
  <link rel="preconnect" href="https://vendor.example">
</defs><div></div></template>`,
  // An application component when the application-components list names its source.
  "badge.html": `<template component="cdn-badge"><defs>
  <meta name="theme-color" content="green"><link rel="preconnect" href="https://cdn.acme.example">
</defs><div></div></template>`,
};

/** The application document's own head. */
export function authoredHead(listed: boolean): string {
  return '<meta charset="utf-8"><title>Acme</title><meta name="description" content="Site">' +
    '<link rel="preconnect" href="https://img.acme.example">' +
    (listed ? `<meta name="application-components" content="https://cdn.acme.example/ui/">` : "");
}

/** What a page records, in the page. */
declare global {
  var app: {
    mount(): void;
    section(text: string): void;
    note(shown: boolean): void;
    cards(count: number): void;
    schema(value: unknown): void;
    page(name: "a" | "b"): void;
    unmount(): void;
  };
}

type Steps = Record<string, unknown>;

/** Runs the scenario and returns each step's observations. */
export async function runHeadScenario(page: Page): Promise<Steps> {
  const settle = (): Promise<void> => page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 20))));
  const head = (): Promise<string[]> => page.evaluate(() => Array.from(
    document.head.querySelectorAll("title, meta[name], meta[property], link, script[type='application/ld+json']"),
    (element) => element.outerHTML.replace(' data-component-head=""', " *")));
  const steps: Steps = {};
  // Remember the authored nodes, to check they come back as the same objects.
  await page.evaluate(() => {
    const kept = globalThis as unknown as Record<string, unknown>;
    kept.authoredTitle = document.querySelector("title");
    kept.authoredDescription = document.querySelector('meta[name="description"]');
    kept.authoredPreconnect = document.querySelector('link[rel="preconnect"]');
  });
  steps.registered = await head();
  await page.evaluate(() => app.mount());
  await settle();
  steps.mounted = await head();
  steps.title = await page.evaluate(() => document.title);

  // Shared keys are reference counted; an authored element with the key satisfies it and stays.
  const counted: string[][] = [];
  for (const count of [1, 0]) {
    await page.evaluate((cards) => app.cards(cards), count);
    await settle();
    counted.push((await head()).filter((line) => line.includes("img.acme") || line.includes("dns-prefetch")));
  }
  steps.counted = counted;
  steps.authoredKept = await page.evaluate(() => (globalThis as unknown as Record<string, unknown>).authoredPreconnect === document.querySelector('link[rel="preconnect"]'));

  // A bound title updates the winner's element in place; a deeper instance takes the key and gives it back.
  await page.evaluate(() => { (globalThis as unknown as Record<string, unknown>).managedTitle = document.querySelector("title"); });
  const titles: string[] = [];
  for (const action of ["section", "note on", "note off"]) {
    await page.evaluate((step) => step === "section" ? app.section("Upgrade") : app.note(step === "note on"), action);
    await settle();
    titles.push(await page.evaluate(() => document.title));
  }
  steps.titles = titles;
  steps.sameTitle = await page.evaluate(() => (globalThis as unknown as Record<string, unknown>).managedTitle === document.querySelector("title"));

  // JSON-LD: a bound value is JSON with every < escaped; null omits it.
  await page.evaluate(() => app.schema({ "@type": "Product", name: "</script><script>alert(1)</script><!--" }));
  await settle();
  steps.schema = await page.evaluate(() => {
    const blocks = document.querySelectorAll("script[type='application/ld+json']");
    const bound = blocks[1]?.textContent ?? "";
    return { count: blocks.length, bound, parsed: JSON.parse(bound) as unknown, alerted: (globalThis as unknown as { alerted?: boolean }).alerted === true };
  });
  await page.evaluate(() => app.schema(null));
  await settle();
  steps.schemaRemoved = await page.evaluate(() => document.querySelectorAll("script[type='application/ld+json']").length);

  // A page change is one reconciliation, inside a view transition's update when the browser has them.
  steps.navigation = await page.evaluate(async () => {
    const seen: string[] = [];
    const removed: Node[] = [];
    const preconnect = document.querySelector('link[href="https://search.acme.example"]');
    const observer = new MutationObserver((records) => {
      seen.push(document.title);
      for (const record of records) removed.push(...record.removedNodes);
    });
    observer.observe(document.head, { subtree: true, childList: true, characterData: true, attributes: true });
    let inUpdate = "";
    const start = (document as Document & { startViewTransition?: (update: () => void) => { updateCallbackDone: Promise<void> } }).startViewTransition;
    if (start === undefined) app.page("b");
    else await start.call(document, () => app.page("b")).updateCallbackDone.then(() => { inUpdate = document.title; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    observer.disconnect();
    return { seen: [...new Set(seen)], inUpdate: start === undefined ? document.title : inUpdate,
      preconnectKept: preconnect === document.querySelector('link[href="https://search.acme.example"]') && !removed.includes(preconnect!) };
  });
  steps.navigated = await head();

  await page.evaluate(() => app.unmount());
  await settle();
  steps.unmounted = await head();
  steps.restored = await page.evaluate(() => {
    const kept = globalThis as unknown as Record<string, unknown>;
    return [kept.authoredTitle === document.querySelector("title"), kept.authoredDescription === document.querySelector('meta[name="description"]'),
      document.querySelectorAll("[data-component-head]").length];
  });
  return steps;
}

const authored = ['<title>Acme</title>', '<meta name="description" content="Site">', '<link rel="preconnect" href="https://img.acme.example">'];
const listedMeta = '<meta name="application-components" content="https://cdn.acme.example/ui/">';

/** What every implementation's head holds at each step. */
export function expectedHead(listed: boolean): Steps {
  const initial = [...authored, ...(listed ? [listedMeta] : [])];
  return {
    registered: initial,
    mounted: [
      "<title *>Install · Docs</title>", '<meta name="description" content="Acme documentation" *>', '<link rel="preconnect" href="https://img.acme.example">',
      ...(listed ? [listedMeta] : []),
      '<link rel="preconnect" href="https://search.acme.example" *>',
      '<meta property="og:image" content="/a-1.png" *>', '<meta property="og:image:width" content="1200" *>', '<meta property="og:image" content="/a-2.png" *>',
      '<link rel="canonical" href="https://acme.example/install" *>', '<meta name="robots" content="noindex" *>',
      '<link rel="dns-prefetch" href="https://cdn.acme.example" *>',
      '<script type="application/ld+json" *>{"@type": "Organization", "name": "{Acme}"}</script>',
      '<link rel="preconnect" href="https://vendor.example" *>',
      ...(listed ? ['<meta name="theme-color" content="green" *>'] : []),
      '<link rel="preconnect" href="https://cdn.acme.example" *>',
    ],
    title: "Install · Docs",
    counted: [
      ['<link rel="preconnect" href="https://img.acme.example">', '<link rel="dns-prefetch" href="https://cdn.acme.example" *>'],
      ['<link rel="preconnect" href="https://img.acme.example">'],
    ],
    authoredKept: true,
    titles: ["Upgrade · Docs", "Note", "Upgrade · Docs"],
    sameTitle: true,
    schema: { count: 2, bound: '{"@type":"Product","name":"\\u003c/script>\\u003cscript>alert(1)\\u003c/script>\\u003c!--"}',
      parsed: { "@type": "Product", name: "</script><script>alert(1)</script><!--" }, alerted: false },
    schemaRemoved: 1,
    navigation: { seen: ["Configure · Docs"], inUpdate: "Configure · Docs", preconnectKept: true },
    navigated: [
      "<title *>Configure · Docs</title>", '<meta name="description" content="Acme documentation" *>', '<link rel="preconnect" href="https://img.acme.example">',
      ...(listed ? [listedMeta] : []),
      '<link rel="preconnect" href="https://search.acme.example" *>',
      // page-b's og:image:width has no og:image of its own, so the layout's list wins the family.
      '<meta property="og:image" content="/layout.png" *>', '<meta property="og:image:alt" content="Acme" *>',
      '<script type="application/ld+json" *>{"@type": "Organization", "name": "{Acme}"}</script>',
      '<link rel="preconnect" href="https://vendor.example" *>',
      ...(listed ? ['<meta name="theme-color" content="green" *>'] : []),
      '<link rel="preconnect" href="https://cdn.acme.example" *>',
    ],
    unmounted: initial,
    restored: [true, true, 0],
  };
}
