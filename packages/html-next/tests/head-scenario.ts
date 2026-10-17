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
  // Reached through a bare specifier, so its page-wide head entries are ignored.
  "widget.html": `<template component="vendor-widget"><defs>
  <link rel="canonical" href="https://vendor.example/"><meta name="theme-color" content="red">
  <link rel="preconnect" href="https://vendor.example">
</defs><div></div></template>`,
  // An application component when the `component-src` list names its source.
  "badge.html": `<template component="cdn-badge"><defs>
  <meta name="theme-color" content="green"><link rel="preconnect" href="https://cdn.acme.example">
</defs><div></div></template>`,
};

/** Declared scripts: an eager one two components share, a lazy one far below the fold, and a manual one. */
export const scriptFiles: Readonly<Record<string, string>> = {
  "scripts.html": `<template component="saved-cards"><defs>
  <state name="loads" type="number" value="0"></state>
  <handler name="loaded"><set name="loads" expr:value="$loads + 1"></set></handler>
  <script name="sdk" src="https://js.example/sdk.js" crossorigin="anonymous" on:load="loaded"></script>
</defs><ul from:data-loads="$loads" from:data-ok="$sdk.ok" from:data-pending="$sdk.pending"></ul></template>
<template component="pay-badge"><defs><script src="https://js.example/sdk.js" crossorigin></script></defs><b></b></template>
<template component="checkout-form"><defs>
  <state name="loads" type="number" value="0"></state>
  <handler name="loaded"><set name="loads" expr:value="$loads + 1"></set></handler>
  <script name="lazy" src="https://js.example/lazy.js" loading="lazy" on:load="loaded"></script>
</defs><form from:data-loads="$loads" from:data-pending="$lazy.pending"></form></template>
<template component="map-view" controller="./maps.js"><defs>
  <script name="maps" src="https://js.example/maps.js" type="module" loading="manual"></script>
</defs><div from:data-ok="$maps.ok" from:data-pending="$maps.pending"></div></template>`,
  "maps.js": `export default function controller(host) {
  globalThis.loadMaps = () => host.scripts.maps.load().then(() => "loaded", () => "failed");
}\n`,
};

/** Each script counts its runs; the shared one arrives late, so a connection can end before it settles. */
export const scriptSources: Readonly<Record<string, string>> = Object.fromEntries(["sdk", "lazy", "maps"].map((name) =>
  [`${name}.js`, `(globalThis.runs ??= {}).${name} = (globalThis.runs.${name} ?? 0) + 1;\n`]));

declare global {
  var scripts: {
    mount(): void;
    remove(id: string): void;
    restore(id: string): void;
    unmount(): void;
  };
}

/** Runs the declared-script scenario: sharing, handlers per connection, lazy and manual loading. */
export async function runScriptScenario(page: Page): Promise<Steps> {
  const settle = (): Promise<void> => page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 20))));
  const read = (): Promise<unknown> => page.evaluate(() => {
    const root = (id: string) => document.getElementById(id);
    return {
      scripts: Array.from(document.querySelectorAll("script[data-component-head]"), (script) => (script as HTMLScriptElement).src.split("/").at(-1)),
      runs: (globalThis as unknown as { runs?: Record<string, number> }).runs ?? {},
      a: [root("a")?.getAttribute("data-loads"), root("a")?.hasAttribute("data-pending"), root("a")?.hasAttribute("data-ok")],
      b: [root("b")?.getAttribute("data-loads"), root("b")?.hasAttribute("data-pending")],
      lazy: root("lazy")?.getAttribute("data-loads"),
      maps: [root("maps")?.hasAttribute("data-pending"), root("maps")?.hasAttribute("data-ok")],
    };
  });
  const steps: Steps = {};
  await page.evaluate(() => scripts.mount());
  await settle();
  steps.mounted = await read();
  // b's connection ends before the shared script settles, and its next connection gets its own handler.
  await page.evaluate(() => scripts.remove("b"));
  await settle();
  await page.evaluate(() => scripts.restore("b"));
  await page.waitForFunction(() => document.getElementById("a")?.getAttribute("data-loads") === "1");
  await settle();
  steps.loaded = await read();
  await page.evaluate(() => scripts.remove("a"));
  await settle();
  await page.evaluate(() => scripts.restore("a"));
  await settle();
  steps.reconnected = await read();
  await page.evaluate(() => document.getElementById("lazy")!.scrollIntoView());
  await page.waitForFunction(() => document.getElementById("lazy")?.getAttribute("data-loads") === "1");
  steps.near = await read();
  steps.manual = await page.evaluate(() => (globalThis as unknown as { loadMaps(): Promise<string> }).loadMaps());
  await settle();
  steps.loadedMaps = await read();
  await page.evaluate(() => scripts.unmount());
  await settle();
  steps.unmounted = await page.evaluate(() => document.querySelectorAll("script[data-component-head]").length);
  return steps;
}

export const expectedScripts: Steps = {
  mounted: { scripts: ["sdk.js"], runs: {}, a: ["0", true, false], b: ["0", true], lazy: "0", maps: [false, false] },
  loaded: { scripts: ["sdk.js"], runs: { sdk: 1 }, a: ["1", false, true], b: ["1", false], lazy: "0", maps: [false, false] },
  reconnected: { scripts: ["sdk.js"], runs: { sdk: 1 }, a: ["2", false, true], b: ["1", false], lazy: "0", maps: [false, false] },
  near: { scripts: ["sdk.js", "lazy.js"], runs: { sdk: 1, lazy: 1 }, a: ["2", false, true], b: ["1", false], lazy: "1", maps: [false, false] },
  manual: "loaded",
  loadedMaps: { scripts: ["sdk.js", "lazy.js", "maps.js"], runs: { sdk: 1, lazy: 1, maps: 1 }, a: ["2", false, true], b: ["1", false], lazy: "1", maps: [false, true] },
  unmounted: 3,
};

/** The application document's own head. */
export function authoredHead(listed: boolean): string {
  return '<meta charset="utf-8"><title>Acme</title><meta name="description" content="Site">' +
    '<link rel="preconnect" href="https://img.acme.example">' +
    (listed ? `<meta name="component-src" content="https://cdn.acme.example/ui/">` : "");
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

  // JSON-LD: a bound value is JSON with every < escaped; a change updates the same block; null omits it.
  await page.evaluate(() => app.schema({ "@type": "Product", name: "</script><script>alert(1)</script><!--" }));
  await settle();
  steps.schema = await page.evaluate(() => {
    const blocks = Array.from(document.querySelectorAll("script[type='application/ld+json']"));
    const block = blocks.find((candidate) => candidate.textContent!.startsWith('{"@type":"Product"'));
    (globalThis as unknown as Record<string, unknown>).boundBlock = block;
    const bound = block?.textContent ?? "";
    return { count: blocks.length, bound, parsed: JSON.parse(bound) as unknown, alerted: (globalThis as unknown as { alerted?: boolean }).alerted === true };
  });
  await page.evaluate(() => app.schema({ "@type": "Product", name: "Anvil" }));
  await settle();
  steps.schemaChanged = await page.evaluate(() => {
    const block = (globalThis as unknown as { boundBlock: Element }).boundBlock;
    return { same: block.isConnected, text: block.textContent, count: document.querySelectorAll("script[type='application/ld+json']").length };
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
const listedMeta = '<meta name="component-src" content="https://cdn.acme.example/ui/">';

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
      // Each instance's JSON-LD is its own block, identical text included.
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
    schema: { count: 3, bound: '{"@type":"Product","name":"\\u003c/script>\\u003cscript>alert(1)\\u003c/script>\\u003c!--"}',
      parsed: { "@type": "Product", name: "</script><script>alert(1)</script><!--" }, alerted: false },
    schemaChanged: { same: true, text: '{"@type":"Product","name":"Anvil"}', count: 3 },
    schemaRemoved: 2,
    navigation: { seen: ["Configure · Docs"], inUpdate: "Configure · Docs", preconnectKept: true },
    navigated: [
      "<title *>Configure · Docs</title>", '<meta name="description" content="Acme documentation" *>', '<link rel="preconnect" href="https://img.acme.example">',
      ...(listed ? [listedMeta] : []),
      '<link rel="preconnect" href="https://search.acme.example" *>',
      // page-b's og:image:width has no og:image of its own, so the layout's list wins the family.
      '<meta property="og:image" content="/layout.png" *>', '<meta property="og:image:alt" content="Acme" *>',
      '<script type="application/ld+json" *>{"@type": "Organization", "name": "{Acme}"}</script>',
      '<script type="application/ld+json" *>{"@type": "Organization", "name": "{Acme}"}</script>',
      '<link rel="preconnect" href="https://vendor.example" *>',
      ...(listed ? ['<meta name="theme-color" content="green" *>'] : []),
      '<link rel="preconnect" href="https://cdn.acme.example" *>',
    ],
    unmounted: initial,
    restored: [true, true, 0],
  };
}
