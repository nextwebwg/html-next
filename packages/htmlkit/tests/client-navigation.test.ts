import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, firefox, webkit, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApplication, devApplication, previewApplication, type ApplicationServer } from "../src/index.js";
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
        <a id="conflict" href="/kit/conflict/">Conflict</a> <a id="missing" href="/kit/missing/">Missing</a></p>
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
    <template component="home-page" controller="./home.ts"><title>Home</title><meta name="description" content="Home page"><meta name="hk:label" content="Home"><article><h1>Home</h1><shared-badge></shared-badge></article></template>`);
  // A global rule only the home page links; leaving home must drop it, as a document load would.
  await write(root, "app/pages/home.ts", "import './home.css'; export default function(host) { host.root.dataset.ready = 'home'; }");
  await write(root, "app/pages/home.css", "body { background-color: rgb(9, 9, 9); }");
  await write(root, "app/pages/guide/index.html", `<template component="guide-page" controller="./guide.ts"><title>Guide</title><meta name="description" content="Guide page"><meta name="hk:label" content="Guide">
    <article><h1>Guide</h1></article><style>:host { color: rgb(4, 5, 6); }</style></template>`);
  await write(root, "app/pages/guide/guide.ts", "export default function(host) { host.root.dataset.ready = 'guide'; }");
  await write(root, "app/pages/guide/install.html", `<template component="install-page"><title>Install</title><meta name="hk:label" content="Install">
    <article><h1>Install</h1><div class="spacer"></div><h2 id="deep">Deep</h2><div class="spacer"></div></article><style>.spacer { height: 3000px; }</style></template>`);
  await write(root, "app/pages/items/[slug].html", `<template component="item-page"><meta name="hk:layout" content="items"><defs><prop name="slug" type="string" required>Slug</prop></defs>
    <title $value="$slug"></title><article><h1 $value="$slug"></h1><a id="home" href="/kit/">Home</a></article></template>`);
  await write(root, "app/pages/items/[slug].server.ts", "export const entries = () => [{ slug: 'one' }, { slug: 'two' }]; export const load = ({ params }) => ({ props: { slug: params.slug } });");
  // Another <shared-badge> cannot join a document that already defines one (HR001).
  await write(root, "app/pages/conflict.html", `<meta name="hk:page" content="conflict-page"><template component="shared-badge"><i>conflict badge</i></template>
    <template component="conflict-page"><title>Conflict</title><meta name="hk:navigation" content="hidden"><article><h1><shared-badge></shared-badge></h1></article></template>`);
  return root;
}

/** Waits for a navigation to settle on a page title. */
async function settled(page: Page, title: string): Promise<void> {
  await page.waitForFunction(expected => document.title === expected && navigation.transition === null && document.readyState === "complete", title);
}
const marked = (page: Page) => page.evaluate(() => (window as unknown as { marker?: boolean }).marker === true);
const mark = (page: Page) => page.evaluate(() => { (window as unknown as { marker: boolean }).marker = true; });

async function scenario(browser: Browser, url: string, built: boolean): Promise<void> {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    const errors: string[] = [];
    // WebKit reports the fetch this test aborts below as a page error; anything else is a failure.
    page.on("pageerror", error => { if (!error.message.includes("/kit/items/two/ due to access control checks")) errors.push(error.message); });
    const fetched: string[] = [];
    page.on("request", request => { if (request.resourceType() === "fetch") fetched.push(new URL(request.url()).pathname); });
    await context.route("https://external.test/**", route => route.fulfill({ contentType: "text/html", body: "<title>External</title>" }));
    await page.goto(url);
    await page.waitForFunction(() => document.querySelector('[data-component="site-shell"]')?.getAttribute("data-connections") === "1");
    await mark(page);
    await page.getByRole("button", { name: "Menu" }).click();
    await page.evaluate(() => { (window as unknown as { shell: Element }).shell = document.getElementById("hk-layer-0")!; });
    expect(await page.locator('nav a[href="/kit/"]').getAttribute("aria-current")).toBe("page");
    if (built) expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe("rgb(9, 9, 9)");

    // Sweeping across links prefetches nothing; resting on one prefetches it once, and the click
    // then renders it in place, keeping the layout.
    const links = await page.locator("nav a").evaluateAll(anchors => anchors.map(anchor => {
      const box = anchor.getBoundingClientRect();
      return [box.x + box.width / 2, box.y + box.height / 2] as const;
    }));
    for (const [x, y] of links) await page.mouse.move(x, y);
    await page.mouse.move(0, 0);
    await page.waitForTimeout(300);
    expect(fetched).toEqual([]);
    const guide = page.getByRole("link", { name: "Guide", exact: true });
    await guide.hover();
    await expect.poll(() => fetched.filter(path => path === "/kit/guide/").length).toBe(1);
    await guide.click();
    await settled(page, "Guide");
    expect(await marked(page)).toBe(true);
    expect(fetched.filter(path => path === "/kit/guide/").length).toBe(1);
    expect(page.url()).toBe(url + "guide/");
    expect(await page.evaluate(() => {
      const shell = document.getElementById("hk-layer-0")!;
      return { kept: shell === (window as unknown as { shell: Element }).shell, connections: shell.dataset.connections,
        expanded: shell.querySelector("button")!.getAttribute("aria-expanded"), page: document.getElementById("hk-layer-1")!.dataset.component,
        ready: document.getElementById("hk-layer-1")!.dataset.ready, color: getComputedStyle(document.getElementById("hk-layer-1")!).color,
        current: [...document.querySelectorAll("nav a")].map(link => [link.getAttribute("href"), link.getAttribute("aria-current")]),
        description: document.querySelector('meta[name="description"]')?.getAttribute("content"), announced: document.getElementById("hk-announcer")!.textContent,
        focus: document.activeElement === document.body, background: getComputedStyle(document.body).backgroundColor };
    })).toEqual({ kept: true, connections: "1", expanded: "true", page: "guide-page", ready: "guide", color: "rgb(4, 5, 6)",
      current: [["/kit/", "false"], ["/kit/guide/", "page"], ["/kit/guide/install/", "false"], ["/kit/items/one/", "false"], ["/kit/items/two/", "false"]],
      description: "Guide page", announced: "Guide", focus: true, background: built ? "rgba(0, 0, 0, 0)" : "rgb(9, 9, 9)" });

    // New entries scroll to their fragment; back and forward restore the saved position.
    await page.locator("#to-deep").click();
    await settled(page, "Install");
    expect(page.url()).toBe(url + "guide/install/#deep");
    await expect.poll(() => page.evaluate(() => [Math.abs(Math.round(document.getElementById("deep")!.getBoundingClientRect().top)), scrollY > 2000])).toEqual([0, true]);
    await page.evaluate(() => scrollTo(0, 1234));
    await page.evaluate(() => document.querySelector<HTMLAnchorElement>('nav a[href="/kit/guide/"]')!.click());
    await settled(page, "Guide");
    expect(await page.evaluate(() => scrollY)).toBe(0);
    await page.goBack();
    await settled(page, "Install");
    await expect.poll(() => page.evaluate(() => scrollY)).toBe(1234);
    expect(await page.locator('nav a[href="/kit/guide/install/"]').getAttribute("aria-current")).toBe("page");
    await page.goForward();
    await settled(page, "Guide");
    expect(await marked(page)).toBe(true);

    // A different layout replaces the layout; returning builds a fresh one.
    await page.locator("#items").click();
    await settled(page, "one");
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
    await page.route("**/kit/guide/install/", async route => { await new Promise(done => setTimeout(done, 500)); await route.continue(); });
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
    });
    await page.getByRole("link", { name: "Guide", exact: true }).click();
    await settled(page, "Guide");
    expect(await page.evaluate(() => (window as unknown as { transitions: number }).transitions))
      .toBe(await page.evaluate(() => typeof CSSViewTransitionRule === "function" ? 1 : 0));
    expect(errors).toEqual([]);
  } finally { await context.close(); }
}

const engines = [["Chromium", chromium], ["Firefox", firefox], ["WebKit", webkit]] as const;

describe.skipIf(process.env.HTMLNEXT_BROWSER_TEST !== "1")("client navigation", () => {
  let root: string;
  let preview: ApplicationServer;
  let development: ApplicationServer;
  beforeAll(async () => {
    root = await site();
    await buildApplication({ root, base: "/kit/" });
    preview = await previewApplication({ root, port: 0 });
    development = await devApplication({ root, base: "/kit/", port: 0 });
  }, 120_000);
  afterAll(async () => { await preview?.close(); await development?.close(); if (root) await rm(root, { recursive: true, force: true }); });

  for (const [name, type] of engines) {
    for (const mode of ["built", "development"] as const) {
      it(`${name} navigates ${mode} pages in place`, async () => {
        const browser = await type.launch({ headless: true });
        try { await scenario(browser, mode === "built" ? preview.url : development.url, mode === "built"); }
        finally { await browser.close(); }
      }, 120_000);
    }
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
