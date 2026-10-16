import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, firefox, webkit, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApplication, devApplication, previewApplication, startApplication, type ApplicationServer } from "../src/index.js";
import { write } from "./fixture.js";

const navigationItems = "list(object({ href: string, label: string, current: string, depth: number, pageName: string }))";

/** A site whose layout keeps state across pages, with every kind of link client navigation must leave alone. */
async function site(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "htmlkit-client-navigation-"));
  await write(root, "package.json", '{"name":"htmlkit-client-navigation","private":true,"type":"module"}');
  await write(root, "app/layouts/default.html", `<template component="site-shell" controller="./shell.ts"><defs>
    <prop name="navigation" type="${navigationItems}" required>Links</prop>
    <state name="open" type="boolean" value="false"></state></defs>
    <div class="shell"><button type="button" $ref="menu" from:aria-expanded="$open">Menu</button>
      <hk-nav from:items="$navigation" label="Site"></hk-nav>
      <p class="links"><a id="external" href="https://external.test/">External</a> <a id="download" href="/kit/guide/" download>Download</a>
        <a id="blank" href="/kit/guide/" target="_blank">Blank</a> <a id="reload" href="/kit/guide/" data-hk-reload>Reload</a>
        <a id="outside" href="/elsewhere/">Outside</a> <a id="hash" href="#top">Hash</a> <a id="to-deep" href="/kit/guide/install/#deep">Deep</a>
        <a id="items" href="/kit/items/one/">Items</a> <a id="broken" href="/kit/items/two/">Broken</a>
        <a id="conflict" href="/kit/conflict/">Conflict</a> <a id="missing" href="/kit/missing/">Missing</a>
        <span data-hk-prefetch="none"><a id="quiet" href="/kit/guide/install/">Quiet</a></span>
        <a id="counter" href="/kit/counter/" data-hk-prefetch="visible">Counter</a></p>
      <slot name="page"></slot></div>
    <style>:host { color: rgb(1, 2, 3); }</style></template>`);
  await write(root, "app/layouts/default.server.ts", "export const load = async ({ navigation }) => ({ props: { navigation: await navigation() } });");
  await write(root, "app/layouts/shell.ts", `export default function(host) {
    host.root.dataset.connections = String(Number(host.root.dataset.connections || 0) + 1);
    const toggle = () => { host.state.open = !host.state.open; };
    host.refs.menu.addEventListener('click', toggle);
    return () => host.refs.menu.removeEventListener('click', toggle);
  }`);
  await write(root, "app/layouts/items.html", '<template component="items-shell"><main class="items"><slot name="page"></slot></main></template>');
  await write(root, "app/pages/index.html", `<meta name="hk:page" content="home-page">
    <template component="shared-badge"><b>home badge</b></template>
    <template component="home-page" controller="./home.ts"><defs><title>Home</title><meta name="description" content="Home page"><meta name="hk:label" content="Home"></defs><article><h1>Home</h1><shared-badge></shared-badge></article></template>`);
  // A global rule only the home page links; leaving home must drop it, as a document load would.
  await write(root, "app/pages/home.ts", "import './home.css'; export default function(host) { host.root.dataset.ready = 'home'; }");
  await write(root, "app/pages/home.css", "body { background-color: rgb(9, 9, 9); }");
  // Shared stylesheet imports put each page's graph in one stylesheet, which client navigation loads.
  await write(root, "app/styles/heading.css", "h1 { border-bottom: 2px solid rgb(7, 8, 9); }");
  await write(root, "app/pages/guide/index.html", `<template component="guide-page" controller="./guide.ts"><defs><title>Guide</title><meta name="description" content="Guide page"><meta name="hk:label" content="Guide">
      <script type="application/ld+json">{"@type":"WebPage","name":"Guide"}</script><script src="/kit/widget.js"></script></defs>
    <article><h1>Guide</h1></article><style>@import "@/app/styles/heading.css"; :host { color: rgb(4, 5, 6); }</style></template>`);
  // A declared script runs once per document, however often its page connects.
  await write(root, "public/widget.js", "window.widgetRuns = (window.widgetRuns ?? 0) + 1;");
  await write(root, "app/pages/guide/guide.ts", "export default function(host) { host.root.dataset.ready = 'guide'; }");
  await write(root, "app/pages/guide/install.html", `<template component="install-page"><defs><title>Install</title><meta name="hk:label" content="Install"></defs>
    <article><h1>Install</h1><div class="spacer"></div><h2 id="deep">Deep</h2><div class="spacer"></div></article><style>@import "@/app/styles/heading.css"; .spacer { height: 3000px; }</style></template>`);
  await write(root, "app/pages/items/[slug].html", `<template component="item-page"><defs><prop name="slug" type="string" required>Slug</prop><meta name="hk:layout" content="items"><title>{$slug}</title></defs><article><h1 $value="$slug"></h1><a id="home" href="/kit/">Home</a></article></template>`);
  await write(root, "app/pages/items/[slug].server.ts", "export const entries = () => [{ slug: 'one' }, { slug: 'two' }]; export const load = ({ params }) => ({ props: { slug: params.slug } });");
  // Another <shared-badge> cannot join a document that already defines one (HR001).
  await write(root, "app/pages/conflict.html", `<meta name="hk:page" content="conflict-page"><template component="shared-badge"><i>conflict badge</i></template>
    <template component="conflict-page"><defs><title>Conflict</title><meta name="hk:navigation" content="hidden"></defs><article><h1><shared-badge></shared-badge></h1></article></template>`);
  // Loader state, typed props, a nested component, a form control, a declared read, and a controller.
  await write(root, "app/pages/counter.html", `<meta name="hk:page" content="counter-page">
    <template component="count-badge"><defs><prop name="count" type="number" default="0">Count</prop></defs><b from:data-count="$count">{$count}</b></template>
    <template component="counter-page" controller="./counter.ts"><defs>
      <prop name="label" type="string" required>Label</prop>
      <prop name="tags" type="list(string)" default="[]">Tags</prop>
      <state name="count" type="number" value="0"></state>
      <state name="text" type="string" value="initial"></state>
      <data name="result" src="./data.json"></data><title>Counter</title><meta name="hk:navigation" content="hidden"></defs>
      <article><h1>{$label}</h1><output>{$count}</output><count-badge from:count="$count"></count-badge><input bind:value="text">
        <p $if="$result.pending">Loading</p><p $if="$result.ok">{$result.value.label}</p>
        <ul><li $each="tag of $tags">{$tag}</li></ul><button type="button" $ref="add">Add</button></article></template>`);
  await write(root, "app/pages/counter.server.ts", `export const load = () => ({ props: { label: "Counter", tags: ["a < b", 'quote " here'] }, state: { count: 4, text: "server" } });`);
  await write(root, "app/pages/counter.ts", `export default function(host) {
    host.root.dataset.connections = String(Number(host.root.dataset.connections || 0) + 1);
    const add = () => { host.state.count += 1; };
    host.refs.add.addEventListener('click', add);
    return () => host.refs.add.removeEventListener('click', add);
  }`);
  await write(root, "app/pages/data.json", '{"label":"Loaded data"}');
  return root;
}

/** Prefetches wait for idle time and, in development, a render; a loaded CI runner needs longer than vitest's 1 s default. */
const poll = <T>(read: () => T | Promise<T>) => expect.poll(read, { timeout: 15_000 });
/** Waits for a navigation to settle on a page title. */
async function settled(page: Page, title: string): Promise<void> {
  await page.waitForFunction(expected => document.title === expected && navigation.transition === null && document.readyState === "complete", title);
}
/** What HTML Next keeps in the head: one title, the page's metadata, and each declared script once. */
const head = (page: Page) => page.evaluate(() => ({ titles: document.querySelectorAll("title").length,
  descriptions: [...document.querySelectorAll('meta[name="description"]')].map(meta => meta.getAttribute("content")),
  schema: [...document.querySelectorAll('script[type="application/ld+json"]')].map(script => script.textContent),
  widgets: document.querySelectorAll('script[src$="/kit/widget.js"]').length, runs: (window as unknown as { widgetRuns?: number }).widgetRuns ?? 0 }));
const marked = (page: Page) => page.evaluate(() => (window as unknown as { marker?: boolean }).marker === true);
const mark = (page: Page) => page.evaluate(() => { (window as unknown as { marker: boolean }).marker = true; });
const payloadPath = (path: string) => `/kit/_htmlkit/pages/${path}payload.json`;
/** A page's own module, as its payload names it. */
async function moduleOf(url: string, path: string): Promise<string> {
  const payload = await (await fetch(new URL(payloadPath(path), url))).json() as { modules: string[] };
  return new URL(payload.modules.at(-1)!, url).pathname;
}

/** Every request a page makes, by pathname, and a page that fails on any page error. */
async function open(context: BrowserContext) {
  const page = await context.newPage();
  const errors: string[] = [];
  // WebKit reports the fetches this test aborts as page errors; anything else is a failure.
  page.on("pageerror", error => { if (!error.message.includes("due to access control checks")) errors.push(error.message); });
  const requests: { path: string; type: string }[] = [];
  page.on("request", request => requests.push({ path: new URL(request.url()).pathname, type: request.resourceType() }));
  const count = (path: string, type?: string) => requests.filter(request => request.path === path && (type === undefined || request.type === type)).length;
  return { page, errors, requests, count };
}

async function scenario(browser: Browser, url: string, built: boolean): Promise<void> {
  const context = await browser.newContext();
  try {
    const { page, errors, requests, count } = await open(context);
    const modules = Object.fromEntries(await Promise.all(["", "guide/", "guide/install/", "items/one/", "counter/"]
      .map(async path => [path, await moduleOf(url, path)] as const)));
    await context.route("https://external.test/**", route => route.fulfill({ contentType: "text/html", body: "<title>External</title>" }));
    await page.goto(url);
    await page.waitForFunction(() => document.querySelector('[data-component="site-shell"]')?.getAttribute("data-connections") === "1");
    await mark(page);
    await page.getByRole("button", { name: "Menu" }).click();
    await page.evaluate(() => { (window as unknown as { shell: Element }).shell = document.getElementById("hk-layer-0")!; });
    expect(await page.locator('nav a[href="/kit/"]').getAttribute("aria-current")).toBe("page");
    expect(await head(page)).toEqual({ titles: 1, descriptions: ["Home page"], schema: [], widgets: 0, runs: 0 });
    if (built) expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe("rgb(9, 9, 9)");

    // Links on screen prefetch shared code only (from the build's manifest), except a link marked
    // data-hk-prefetch="visible", which prefetches its page's payload and module.
    const payloads = () => requests.filter(request => request.path.includes("/_htmlkit/pages/")).map(request => request.path);
    const pageModules = () => requests.filter(request => Object.values(modules).includes(request.path) && request.path !== modules[""]).map(request => request.path);
    await poll(() => [payloads(), pageModules()]).toEqual([[payloadPath("counter/")], [modules["counter/"]]]);
    await page.waitForTimeout(300);
    expect([payloads(), pageModules()]).toEqual([[payloadPath("counter/")], [modules["counter/"]]]);
    expect(count("/kit/_htmlkit/manifest.json")).toBe(built ? 1 : 0);

    // Sweeping across links prefetches nothing, nor does hovering a data-hk-prefetch="none" link.
    const links = await page.locator("nav a").evaluateAll(anchors => anchors.map(anchor => {
      const box = anchor.getBoundingClientRect();
      return [box.x + box.width / 2, box.y + box.height / 2] as const;
    }));
    for (const [x, y] of links) await page.mouse.move(x, y);
    await page.mouse.move(0, 0);
    await page.locator("#quiet").hover();
    await page.locator("#quiet").focus();
    await page.waitForTimeout(300);
    expect(payloads()).toEqual([payloadPath("counter/")]);

    // Resting on a link prefetches its payload and module once; the click renders the page in place
    // from them, keeping the layout, without fetching its HTML.
    const guide = page.getByRole("link", { name: "Guide", exact: true });
    await guide.hover();
    await poll(() => [count(payloadPath("guide/")), count(modules["guide/"]!)]).toEqual([1, 1]);
    await guide.click();
    await settled(page, "Guide");
    expect([count(payloadPath("guide/")), count(modules["guide/"]!), count("/kit/guide/")]).toEqual([1, 1, 0]);
    expect(await marked(page)).toBe(true);
    expect(page.url()).toBe(url + "guide/");
    expect(await page.evaluate(() => {
      const shell = document.getElementById("hk-layer-0")!;
      return { kept: shell === (window as unknown as { shell: Element }).shell, connections: shell.dataset.connections,
        expanded: shell.querySelector("button")!.getAttribute("aria-expanded"), page: document.getElementById("hk-layer-1")!.dataset.component,
        ready: document.getElementById("hk-layer-1")!.dataset.ready, color: getComputedStyle(document.getElementById("hk-layer-1")!).color,
        shared: getComputedStyle(document.querySelector("#hk-layer-1 h1")!).borderBottomColor,
        current: [...document.querySelectorAll("nav a")].map(link => [link.getAttribute("href"), link.getAttribute("aria-current")]),
        description: document.querySelector('meta[name="description"]')?.getAttribute("content"), announced: document.getElementById("hk-announcer")!.textContent,
        focus: document.activeElement === document.body, background: getComputedStyle(document.body).backgroundColor };
    })).toEqual({ kept: true, connections: "1", expanded: "true", page: "guide-page", ready: "guide", color: "rgb(4, 5, 6)", shared: "rgb(7, 8, 9)",
      current: [["/kit/", "false"], ["/kit/guide/", "page"], ["/kit/guide/install/", "false"], ["/kit/items/one/", "false"], ["/kit/items/two/", "false"]],
      description: "Guide page", announced: "Guide", focus: true, background: built ? "rgba(0, 0, 0, 0)" : "rgb(9, 9, 9)" });
    await poll(() => head(page)).toEqual({ titles: 1, descriptions: ["Guide page"], schema: ['{"@type":"WebPage","name":"Guide"}'], widgets: 1, runs: 1 });

    // A touch prefetches at once.
    await page.locator("#items").evaluate(link => link.dispatchEvent(new Event("touchstart", { bubbles: true })));
    await poll(() => [count(payloadPath("items/one/")), count(modules["items/one/"]!)]).toEqual([1, 1]);

    // A page whose payload fails renders from its HTML instead. New entries scroll to their
    // fragment; back and forward restore the saved position.
    await page.route(`**${payloadPath("guide/install/")}`, route => route.fulfill({ status: 404 }));
    await page.locator("#to-deep").click();
    await settled(page, "Install");
    await page.unroute(`**${payloadPath("guide/install/")}`);
    expect([await marked(page), count("/kit/guide/install/", "fetch")]).toEqual([true, 1]);
    expect(page.url()).toBe(url + "guide/install/#deep");
    expect(await head(page)).toEqual({ titles: 1, descriptions: [], schema: [], widgets: 1, runs: 1 });
    expect(await page.locator("#hk-layer-1 h1").evaluate(heading => getComputedStyle(heading).borderBottomColor)).toBe("rgb(7, 8, 9)");
    await poll(() => page.evaluate(() => [Math.abs(Math.round(document.getElementById("deep")!.getBoundingClientRect().top)), scrollY > 2000])).toEqual([0, true]);
    await page.evaluate(() => scrollTo(0, 1234));
    await page.evaluate(() => document.querySelector<HTMLAnchorElement>('nav a[href="/kit/guide/"]')!.click());
    await settled(page, "Guide");
    expect(await page.evaluate(() => scrollY)).toBe(0);
    await page.goBack();
    await settled(page, "Install");
    await poll(() => page.evaluate(() => scrollY)).toBe(1234);
    expect(await page.locator('nav a[href="/kit/guide/install/"]').getAttribute("aria-current")).toBe("page");
    await page.goForward();
    await settled(page, "Guide");
    expect(await marked(page)).toBe(true);
    expect(await head(page)).toEqual({ titles: 1, descriptions: ["Guide page"], schema: ['{"@type":"WebPage","name":"Guide"}'], widgets: 1, runs: 1 });

    // A different layout replaces the layout; returning builds a fresh one.
    await page.locator("#items").click();
    await settled(page, "one");
    expect(count(payloadPath("items/one/"))).toBe(1);
    expect(await page.evaluate(() => [document.getElementById("hk-layer-0")!.dataset.component, document.getElementById("hk-layer-0") === (window as unknown as { shell: Element }).shell]))
      .toEqual(["items-shell", false]);
    await page.locator("#home").click();
    await settled(page, "Home");
    expect(await page.evaluate(() => [document.getElementById("hk-layer-0")!.dataset.component, document.querySelector(".shell button")!.getAttribute("aria-expanded"),
      document.getElementById("hk-layer-1")!.dataset.ready])).toEqual(["site-shell", "false", "home"]);
    expect(await marked(page)).toBe(true);

    // Native behavior: fragments, downloads, other browsing contexts, and modified clicks.
    await page.locator("#hash").click();
    expect(page.url()).toBe(url + "#top");
    const download = page.waitForEvent("download");
    await page.locator("#download").click();
    await download;
    const popup = context.waitForEvent("page");
    await page.locator("#blank").click();
    await (await popup).close();
    const modified = context.waitForEvent("page");
    await page.getByRole("link", { name: "Install", exact: true }).click({ modifiers: ["ControlOrMeta"] });
    await (await modified).close();
    expect(page.url()).toBe(url + "#top");
    expect(await marked(page)).toBe(true);

    // Opt-outs and anything that cannot render in place load as documents.
    const loads = async (selector: string, title: string, path: string, text = title) => {
      await mark(page);
      await page.locator(selector).click();
      await settled(page, title);
      expect(await marked(page)).toBe(false);
      expect(new URL(page.url()).pathname).toBe(path);
      expect(await page.locator("h1").first().textContent()).toBe(text);
      await page.goto(url);
    };
    await loads("#reload", "Guide", "/kit/guide/");
    await loads("#missing", "Page not found", "/kit/missing/");
    await loads("#conflict", "Conflict", "/kit/conflict/", "conflict badge");
    await page.route(`**${payloadPath("items/two/")}`, route => route.abort());
    await page.route("**/kit/items/two/", route => route.request().resourceType() === "fetch" ? route.abort() : route.continue());
    await loads("#broken", "two", "/kit/items/two/");
    await mark(page);
    await page.locator("#external").click();
    await settled(page, "External");
    expect(await marked(page)).toBe(false);
    await page.goto(url);
    // Vite answers outside its base without a document, so development checks only the request.
    if (built) await loads("#outside", "Page not found", "/elsewhere/");
    else await Promise.all([page.waitForRequest(request => request.isNavigationRequest() && request.url().endsWith("/elsewhere/")), page.locator("#outside").click()]);
    await page.goto(url);

    // A later navigation supersedes a slower one, which never renders.
    await mark(page);
    await page.route(`**${payloadPath("guide/install/")}`, async route => { await new Promise(done => setTimeout(done, 500)); await route.continue(); });
    await page.evaluate(() => document.querySelector<HTMLAnchorElement>('nav a[href="/kit/guide/install/"]')!.click());
    await page.getByRole("link", { name: "Guide", exact: true }).click();
    await settled(page, "Guide");
    await page.waitForTimeout(700);
    expect([await page.title(), await page.locator("h1").textContent(), await marked(page)]).toEqual(["Guide", "Guide", true]);

    // Authors who opt in to animated document navigation get a view transition for client navigation too.
    await page.goto(url);
    await page.evaluate(() => {
      const style = document.createElement("style");
      style.textContent = "@media screen { @view-transition { navigation: auto; } }";
      document.head.append(style);
      const start = document.startViewTransition.bind(document);
      Object.assign(window, { transitions: 0 });
      document.startViewTransition = (update => { (window as unknown as { transitions: number }).transitions++; return start(update); }) as typeof start;
      // The title changes once: no title but the next page's ever shows.
      const titles = [document.title];
      new MutationObserver(() => { if (titles.at(-1) !== document.title) titles.push(document.title); })
        .observe(document.head, { subtree: true, childList: true, characterData: true });
      Object.assign(window, { titles });
    });
    await page.getByRole("link", { name: "Guide", exact: true }).click();
    await settled(page, "Guide");
    expect(await page.evaluate(() => (window as unknown as { titles: string[] }).titles)).toEqual(["Home", "Guide"]);
    expect(await page.evaluate(() => (window as unknown as { transitions: number }).transitions))
      .toBe(await page.evaluate(() => typeof CSSViewTransitionRule === "function" ? 1 : 0));
    expect(errors).toEqual([]);
  } finally { await context.close(); }
}

/**
 * The layers a page shows once its read has loaded, without the hydration record that only server HTML
 * carries. Each element's attributes are in name order: a compiled component created in the browser
 * writes the same attributes as the server's renderer, in its own order.
 */
async function layers(page: Page) {
  await page.getByText("Loaded data", { exact: true }).waitFor();
  return page.evaluate(() => ({
    markup: [0, 1].map(index => {
      const copy = document.getElementById(`hk-layer-${index}`)!.cloneNode(true) as Element;
      for (const element of [copy, ...copy.querySelectorAll("*")]) {
        const attributes = [...element.attributes].map(({ name, value }) => [name, value] as const).sort(([a], [b]) => a < b ? -1 : 1);
        for (const [name] of attributes) element.removeAttribute(name);
        for (const [name, value] of attributes) element.setAttribute(name, value);
      }
      return copy.outerHTML.replace(/ data-html-next-instance="[^"]*"/g, "");
    }),
    connections: document.getElementById("hk-layer-1")!.dataset.connections, value: document.querySelector("input")!.value,
  }));
}

/** A page rendered in the browser from its payload matches the same page rendered by the server. */
async function parity(browser: Browser, url: string): Promise<void> {
  const context = await browser.newContext();
  try {
    const { page, errors, count } = await open(context);
    await page.goto(url);
    await page.waitForFunction(() => document.querySelector('[data-component="site-shell"]')?.getAttribute("data-connections") === "1");
    await mark(page);
    await page.locator("#counter").click();
    await settled(page, "Counter");
    const client = await layers(page);
    expect([await marked(page), count("/kit/counter/", "fetch"), count(payloadPath("counter/"))]).toEqual([true, 0, 1]);
    expect(client).toMatchObject({ connections: "1", value: "server" });
    expect(await page.locator("output").textContent()).toBe("4");
    await page.goto(url + "counter/");
    expect(await layers(page)).toEqual(client);
    // The client-rendered page works as the server-rendered one does.
    await page.goBack();
    await page.locator("#counter").click();
    await settled(page, "Counter");
    await page.getByRole("button", { name: "Add" }).click();
    expect([await page.locator("output").textContent(), await page.locator("[data-count]").textContent()]).toEqual(["5", "5"]);
    expect(errors).toEqual([]);
  } finally { await context.close(); }
}

const engines = [["Chromium", chromium], ["Firefox", firefox], ["WebKit", webkit]] as const;

describe.skipIf(process.env.HTMLNEXT_BROWSER_TEST !== "1")("client navigation", () => {
  let root: string;
  let preview: ApplicationServer;
  let visible: ApplicationServer;
  let development: ApplicationServer;
  beforeAll(async () => {
    root = await site();
    // The links include a missing page, for the not-found page.
    await buildApplication({ root, base: "/kit/", linkCheck: "warn" });
    await buildApplication({ root, base: "/kit/", outDir: "visible", prefetch: "visible", linkCheck: "warn" });
    preview = await previewApplication({ root, port: 0 });
    visible = await previewApplication({ root, outDir: "visible", port: 0 });
    development = await devApplication({ root, base: "/kit/", port: 0 });
  }, 120_000);
  afterAll(async () => {
    await preview?.close(); await visible?.close(); await development?.close();
    if (root) await rm(root, { recursive: true, force: true });
  });

  for (const [name, type] of engines) {
    for (const mode of ["built", "development"] as const) {
      it(`${name} navigates ${mode} pages in place, rendering them like the server`, async () => {
        const browser = await type.launch({ headless: true });
        const url = mode === "built" ? preview.url : development.url;
        try { await scenario(browser, url, mode === "built"); await parity(browser, url); }
        finally { await browser.close(); }
      }, 120_000);
    }

    it(`${name} prefetches pages for links on screen when the site chooses "visible"`, async () => {
      const browser = await type.launch({ headless: true });
      try {
        const { page, requests, count } = await open(await browser.newContext());
        await page.goto(visible.url);
        const paths = ["guide/", "guide/install/", "items/one/", "items/two/", "counter/"];
        const modules = await Promise.all(paths.map(path => moduleOf(visible.url, path)));
        await poll(() => paths.map(path => count(payloadPath(path)))).toEqual(paths.map(() => 1));
        await poll(() => modules.map(module => count(module))).toEqual(modules.map(() => 1));
        expect(requests.filter(request => request.path === payloadPath(""))).toEqual([]);
      } finally { await browser.close(); }
    }, 60_000);
  }

  it("leaves links as document navigations without JavaScript", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await (await browser.newContext({ javaScriptEnabled: false })).newPage();
      await page.goto(preview.url);
      await page.getByRole("link", { name: "Guide", exact: true }).click();
      await page.waitForURL(preview.url + "guide/");
      expect(await page.title()).toBe("Guide");
      expect(await page.locator('nav a[href="/kit/guide/"]').getAttribute("aria-current")).toBe("page");
    } finally { await browser.close(); }
  });
});

describe.skipIf(process.env.HTMLNEXT_BROWSER_TEST !== "1")("client navigation through nested layouts", () => {
  let root: string;
  let preview: ApplicationServer;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "htmlkit-nested-layouts-"));
    await write(root, "package.json", '{"name":"htmlkit-nested-layouts","private":true,"type":"module"}');
    // A navigation tree, whose folders open around the current page as client navigation moves.
    await write(root, "app/layouts/default.html", `<template component="site-shell"><defs>
      <prop name="tree" type="list(object({ label: string, current: string, depth: number, ... }))" required>Tree</prop></defs>
      <div class="site"><hk-nav from:items="$tree"></hk-nav><slot name="page"></slot></div></template>`);
    await write(root, "app/layouts/default.server.ts", "export const load = async ({ navigationTree }) => ({ props: { tree: await navigationTree() } });");
    await write(root, "app/pages/index.html", '<template component="home-page"><defs><title>Home</title></defs><article><a id="to-a" href="/docs/a/">A</a></article></template>');
    await write(root, "app/pages/docs/_layout.html", `<template component="docs-shell" controller="./shell.ts"><defs><prop name="section" type="string" required>Section</prop></defs>
      <div class="docs"><aside from:data-section="$section">Docs</aside><slot name="page"></slot></div></template>`);
    await write(root, "app/pages/docs/_layout.server.ts", "export const load = ({ url }) => ({ props: { section: url.pathname } });");
    await write(root, "app/pages/docs/shell.ts", "export default function(host) { host.root.dataset.connections = String(Number(host.root.dataset.connections || 0) + 1); }");
    await write(root, "app/pages/docs/a.html", '<template component="a-page"><defs><title>A</title></defs><article><a id="to-b" href="/docs/b/">B</a></article></template>');
    await write(root, "app/pages/docs/b.html", '<template component="b-page"><defs><title>B</title></defs><article><a id="to-deep" href="/docs/x/y/z/deep/">Deep</a></article></template>');
    // Below <hk-nav>'s three inline levels, in its <hk-nav-items> instances.
    await write(root, "app/pages/docs/x/y/z/deep.html", '<template component="deep-page"><defs><title>Deep</title></defs><article><a id="to-home" href="/">Home</a></article></template>');
    await buildApplication({ root });
    preview = await previewApplication({ root, port: 0 });
  }, 120_000);
  afterAll(async () => {
    await preview?.close();
    if (root) await rm(root, { recursive: true, force: true });
  });

  for (const [name, type] of engines) {
    it(`${name} keeps the layouts two pages in one folder share`, async () => {
      const browser = await type.launch({ headless: true });
      try {
        const { page, errors } = await open(await browser.newContext());
        await page.goto(preview.url + "docs/a/");
        await page.waitForFunction(() => document.getElementById("hk-layer-1")?.dataset.connections === "1");
        await mark(page);
        await page.evaluate(() => { (window as unknown as { docs: Element }).docs = document.getElementById("hk-layer-1")!; });
        await page.locator("#to-b").click();
        await settled(page, "B");
        expect(await page.evaluate(() => {
          const docs = document.getElementById("hk-layer-1")!;
          return [docs === (window as unknown as { docs: Element }).docs, docs.dataset.connections, docs.querySelector("aside")!.dataset.section,
            document.getElementById("hk-layer-2")!.dataset.component];
        })).toEqual([true, "1", "/docs/b/", "b-page"]);
        const tree = () => page.evaluate(() => [document.querySelector<HTMLDetailsElement>("nav details")!.open, document.querySelector("nav summary")!.textContent,
          document.querySelector('nav a[aria-current="page"]')?.textContent ?? null]);
        expect(await tree()).toEqual([true, "docs", "b"]);
        await page.locator("#to-deep").click();
        await settled(page, "Deep");
        expect(await page.evaluate(() => [[...document.querySelectorAll<HTMLDetailsElement>("nav details")].map(details => details.open),
          document.querySelector('nav a[aria-current="page"]')?.textContent ?? null])).toEqual([[true, true, true, true], "deep"]);
        // Leaving the folder drops its layout, and its folder closes in the tree.
        await page.locator("#to-home").click();
        await settled(page, "Home");
        expect(await page.evaluate(() => [document.getElementById("hk-layer-1")!.dataset.component, document.getElementById("hk-layer-2")])).toEqual(["home-page", null]);
        expect(await tree()).toEqual([false, "docs", "Home"]);
        expect([await marked(page), errors]).toEqual([true, []]);
      } finally { await browser.close(); }
    }, 60_000);
  }
});

describe.skipIf(process.env.HTMLNEXT_BROWSER_TEST !== "1")("client navigation to server-rendered pages", () => {
  let root: string;
  let server: ApplicationServer;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "htmlkit-server-navigation-"));
    await write(root, "package.json", '{"type":"module"}');
    await write(root, "app/layouts/default.html", `<template component="list-shell"><div class="shell"><a id="home" href="/">Home</a> <a id="two" href="/list/?page=2">Two</a>
      <a id="three" href="/list/?page=3">Three</a><slot name="page"></slot></div></template>`);
    await write(root, "app/pages/index.html", '<template component="home-page"><defs><title>Home</title></defs><h1>Home</h1></template>');
    await write(root, "app/pages/list.html", `<template component="list-page"><defs>
      <prop name="title" type="string" required>Title</prop><prop name="reader" type="string" required>Reader</prop><meta name="hk:render" content="server"><title>{$title}</title></defs><article><h1>{$title}</h1><p class="reader">{$reader}</p></article></template>`);
    await write(root, "app/pages/list.server.ts", 'export const load = ({ url, cookies }) => ({ props: { title: "Page " + (url.searchParams.get("page") ?? "1"), reader: cookies.get("reader") ?? "nobody" } });');
    const { outDir } = await buildApplication({ root });
    server = await startApplication({ outDir, port: 0 });
  }, 120_000);
  afterAll(async () => {
    await server?.close();
    if (root) await rm(root, { recursive: true, force: true });
  });

  for (const [name, type] of engines) {
    it(`${name} renders a server page in place with the link's query and the reader's cookies`, async () => {
      const browser = await type.launch({ headless: true });
      try {
        const context = await browser.newContext();
        await context.addCookies([{ name: "reader", value: "ada", url: server.url }]);
        const { page, errors, requests } = await open(context);
        await page.goto(server.url);
        await page.waitForFunction(() => document.querySelector('[data-component="home-page"]') !== null && document.readyState === "complete");
        await mark(page);
        await page.locator("#two").click();
        await settled(page, "Page 2");
        // A change of query alone is a change of page, and Back returns to the previous one.
        await page.locator("#three").click();
        await settled(page, "Page 3");
        await page.goBack();
        await settled(page, "Page 2");
        expect([await page.locator("h1").textContent(), await page.locator(".reader").textContent()]).toEqual(["Page 2", "ada"]);
        expect(requests.some(request => request.path === "/_htmlkit/pages/list/payload.json")).toBe(true);
        expect([await marked(page), errors]).toEqual([true, []]);
      } finally { await browser.close(); }
    }, 60_000);
  }
});
