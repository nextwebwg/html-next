import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";

import { build } from "esbuild";
import { chromium, firefox, webkit, type Browser, type Route } from "playwright";

const enabled = process.env.HTMLNEXT_BROWSER_TEST === "1";
const browserLoaderUrl = new URL("../src/browser-loader.ts", import.meta.url);
const browserDistributableUrl = new URL("../src/browser.ts", import.meta.url);

describe.skipIf(!enabled)("browser graph loader", () => {
  let browser: Browser;
  let bundlePath = "";
  let bundleInputs: readonly string[] = [];
  let distributablePath = "";
  let temporaryDirectory = "";

  beforeAll(async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "html-next-browser-loader-"));
    bundlePath = join(temporaryDirectory, "browser-loader.js");
    const result = await build({
      entryPoints: [browserLoaderUrl.pathname],
      bundle: true,
      format: "iife",
      globalName: "HtmlNextLoader",
      metafile: true,
      outfile: bundlePath,
      platform: "browser",
      target: ["es2022"],
    });
    bundleInputs = Object.keys(result.metafile.inputs);
    distributablePath = join(temporaryDirectory, "browser.js");
    await build({
      entryPoints: [browserDistributableUrl.pathname],
      bundle: true,
      format: "esm",
      outfile: distributablePath,
      platform: "browser",
      target: ["es2022"],
    });
    browser = await chromium.launch({ headless: true });
  });

  afterAll(async () => {
    await browser?.close();
    if (temporaryDirectory !== "") await rm(temporaryDirectory, { recursive: true, force: true });
  });

  it("uses the browser's HTML parser instead of bundling parse5", () => {
    assert.equal(bundleInputs.some((path) => path.includes("/parse5/")), false);
    assert.equal(bundleInputs.some((path) => path.includes("/generated/dom-properties")), false);
  });

  for (const engine of [chromium, firefox, webkit]) {
    it(`${engine.name()} shares imported defaults across adopters, preserves slot and pseudo-element boundaries, and keeps CSS order after DOM moves`, async () => {
      const browser = await engine.launch();
      try {
        const page = await browser.newPage();
        const requests: string[] = [];
        const requestTypes: string[] = [];
        await page.route("https://shared.example/**", async route => {
          const path = new URL(route.request().url()).pathname;
          requests.push(path);
          requestTypes.push(`${path}:${route.request().resourceType()}`);
          const body = path === "/defaults.css" ? `
            :host, *, :host::before, :host::after, *::before, *::after { box-sizing: border-box; }
            :host-state([open]) .own { color: rgb(1, 2, 3); }
            @media (width > 1px) { @keyframes pulse { to { opacity: .5; } } }
          ` : `<!doctype html><head></head><body>
            ${["x-a", "x-b"].map(tag => `<template component="${tag}"><defs><state name="open" type="boolean" value="true"></state></defs><section><span class="own">own</span><slot></slot></section><style>@import "defaults.css";${tag === "x-a" ? ':host { box-sizing: content-box; }' : ''}</style></template>`).join("")}
            <x-a id="a"><p id="projected">projected</p></x-a><x-b id="b"></x-b>
          </body>`;
          await route.fulfill({ contentType: path.endsWith(".css") ? "text/css" : "text/html", body });
        });
        await page.goto("https://shared.example/");
        await page.addScriptTag({ path: bundlePath });
        await page.evaluate(async () => {
          await (window as unknown as { HtmlNextLoader: { startBrowserComponents(): Promise<unknown> } }).HtmlNextLoader.startBrowserComponents();
        });
        const values = await page.evaluate(() => {
          const read = (selector: string, pseudo?: string) => getComputedStyle(document.querySelector(selector)!, pseudo).boxSizing;
          return { a: read("#a"), b: read("#b"), own: read("#a .own"), before: read("#a .own", "::before"),
            projected: read("#projected"), projectedBefore: read("#projected", "::before"),
            color: getComputedStyle(document.querySelector("#b .own")!).color,
            shared: document.querySelectorAll("style[data-html-next-shared-styles]").length,
            bodyCopies: [...document.querySelectorAll("style")].map(style => style.textContent).join("\n").match(/box-sizing: border-box/g)?.length,
            conditionalKeyframes: [...document.querySelectorAll("style")].some(style => /@media[\s\S]*@keyframes pulse/.test(style.textContent ?? "")),
          };
        });
        assert.deepEqual(values, { a: "content-box", b: "border-box", own: "border-box", before: "border-box",
          projected: "content-box", projectedBefore: "content-box", color: "rgb(1, 2, 3)", shared: 1, bodyCopies: 1, conditionalKeyframes: true },
          await page.evaluate(() => [...document.querySelectorAll("style")].map(style => style.textContent).join("\n") + document.body.innerHTML));
        const moved = await page.evaluate(async () => {
          const before = [...document.head.querySelectorAll("style")];
          const content = before.map(style => style.textContent);
          document.body.prepend(document.querySelector("#b")!);
          await new Promise(resolve => setTimeout(resolve, 20));
          return before.every((style, index) => document.head.querySelectorAll("style")[index] === style && style.textContent === content[index]);
        });
        assert.equal(moved, true);
        // Firefox's HTML preload scanner can request an import in a template before our loader runs.
        assert.equal(requestTypes.filter(request => request === "/defaults.css:fetch").length, 1, requestTypes.join(", "));
      } finally { await browser.close(); }
    });
  }

  for (const engine of [chromium, firefox, webkit]) {
    it(`${engine.name()} loads component resources without promoting their metadata into the document`, async () => {
      const metadataBrowser = await engine.launch({ headless: true });
      try {
        const page = await metadataBrowser.newPage();
        const requests: string[] = [];
        await page.route("https://metadata.example/**", async (route) => {
          const path = new URL(route.request().url()).pathname;
          requests.push(path);
          const body = path === "/page.html" ?
            '<meta name="htmlkit:layout" content="admin"><head>' +
            '<title $value="$missing">Imported title</title>' +
            '<meta name="description" content="Imported description" from:content="$missing">' +
            '<meta property="og:title" content="Imported social title">' +
            '<link rel="stylesheet" href="./ignored.css">' +
            '<link rel="canonical" href="https://other.example/">' +
            '<link rel="preload" as="script" href="./ignored.js">' +
            '<link rel="component" href="./child.html"></head>' +
            '<template component="products-page"><title $value="$missing">Carrier title</title>' +
            '<meta name="htmlkit:layout" content="admin"><meta name="description" from:content="$missing">' +
            '<link rel="stylesheet" href="./carrier.css"><link rel="preload" as="script" href="./carrier.js">' +
            '<section>Products <product-detail></product-detail></section></template>' :
            path === "/child.html" ?
              '<template component="product-detail"><title>Helper title</title><meta property="og:title" content="Helper social title"><b>detail</b></template>' :
              '<!doctype html><html><head><title>Host title</title>' +
              '<meta name="description" content="Host description">' +
              '<link rel="component" href="/page.html"></head>' +
              '<body><products-page id="page"></products-page></body></html>';
          await route.fulfill({ contentType: "text/html", body });
        });
        await page.goto("https://metadata.example/");
        await page.addScriptTag({ path: bundlePath });
        const result = await page.evaluate(async () => {
          const api = (window as unknown as { HtmlNextLoader: {
            startBrowserComponents(): Promise<{ graph: { nodes: Map<string, unknown> }; stop(): void }>;
          } }).HtmlNextLoader;
          const started = await api.startBrowserComponents();
          const value = { components: started.graph.nodes.size,
            tag: document.querySelector("#page")?.localName,
            text: document.querySelector("#page")?.textContent,
            title: document.title,
            description: document.querySelector('meta[name="description"]')?.getAttribute("content"),
            layouts: document.querySelectorAll('meta[name="htmlkit:layout"]').length,
            social: document.querySelectorAll('meta[property="og:title"]').length,
            links: document.querySelectorAll('link[rel="stylesheet"], link[rel="canonical"], link[rel="preload"]').length };
          started.stop();
          return value;
        });
        assert.deepEqual(result, { components: 2, tag: "section", text: "Products detail",
          title: "Host title", description: "Host description", layouts: 0, social: 0, links: 0 });
        assert.deepEqual(requests.sort(), ["/", "/child.html", "/page.html"]);
      } finally {
        await metadataBrowser.close();
      }
    });
  }

  it("fetches a multi-component library once and renders both definitions and sibling invocations", async () => {
    const page = await browser.newPage();
    let requests = 0;
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("https://library.example/**", async (route) => {
      const library = route.request().url().endsWith("/library.html");
      if (library) requests += 1;
      await route.fulfill({ contentType: "text/html", body: library ? `
        <template component="ui-button" status="early" summary="Button."><button>Save</button></template>
        <template component="ui-dialog" status="early" summary="Dialog."><section><ui-button></ui-button></section></template>
      ` : '<link rel="component" href="/library.html"><ui-button id="button"></ui-button><ui-dialog id="dialog"></ui-dialog>' });
    });
    try {
      await page.goto("https://library.example/");
      await page.addScriptTag({ path: bundlePath });
      const result = await page.evaluate(async () => {
        const api = (window as unknown as { HtmlNextLoader: {
          startBrowserComponents(): Promise<{ graph: { nodes: Map<string, unknown> }; stop(): void }>;
        } }).HtmlNextLoader;
        const started = await api.startBrowserComponents();
        const value = { count: started.graph.nodes.size, button: document.querySelector("#button")?.localName,
          dialog: document.querySelector("#dialog")?.localName, child: document.querySelector("#dialog button")?.textContent };
        started.stop();
        return value;
      });
      assert.deepEqual(result, { count: 2, button: "button", dialog: "section", child: "Save" });
      assert.equal(requests, 1);
      assert.deepEqual(errors, []);
    } finally {
      await page.close();
    }
  });

  it("starts the linkable browser distributable when the module executes", async () => {
    const page = await browser.newPage();
    await page.route("https://distribution.example/**", async (route) => {
      const url = route.request().url();
      if (url.endsWith("/x-ready.html")) {
        await route.fulfill({
          contentType: "text/html",
          body: '<template component="x-ready" status="early" summary="Ready."><output>ready</output></template>',
        });
      } else {
        await route.fulfill({
          contentType: "text/html",
          body: '<link rel="component" href="/x-ready.html"><x-ready id="ready"></x-ready>',
        });
      }
    });
    await page.goto("https://distribution.example/");
    await page.addScriptTag({ path: distributablePath, type: "module" });
    const result = await page.evaluate(async () => {
      const ready = (window as unknown as { HTMLNext?: { ready: Promise<unknown> } }).HTMLNext?.ready;
      await ready;
      return {
        exposed: ready instanceof Promise,
        api: Object.keys((window as unknown as { HTMLNext: object }).HTMLNext),
        tag: document.querySelector("#ready")?.localName,
        text: document.querySelector("#ready")?.textContent,
      };
    });
    await page.close();
    // Loading the entry is the whole setup; there is nothing to start by hand.
    assert.deepEqual(result, { exposed: true, api: ["ready"], tag: "output", text: "ready" });
  });

  it("loads component links added after start and renders the instances waiting for them", async () => {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
    page.on("pageerror", (error) => errors.push(error.message));
    const components: Record<string, string> = {
      "/first.html":
        '<link rel="component" href="./shared.html">' +
        '<template component="x-first" status="early" summary="First."><output>first <x-shared></x-shared></output></template>',
      "/late.html":
        '<link rel="component" href="./shared.html">' +
        '<template component="x-late" status="early" summary="Late."><output>late <x-shared></x-shared></output></template>',
      "/shared.html": '<template component="x-shared" status="early" summary="Shared."><b>shared</b></template>',
    };
    await page.route("https://late.example/**", async (route) => {
      const body = components[new URL(route.request().url()).pathname];
      await route.fulfill({
        contentType: "text/html",
        body: body ?? '<link rel="component" href="/first.html"><x-first id="first"></x-first><x-late id="waiting"></x-late>',
      });
    });
    await page.goto("https://late.example/");
    await page.addScriptTag({ path: distributablePath, type: "module" });
    const rendered = (id: string) => page.evaluate((selector) => {
      const element = document.querySelector(selector);
      return element === null ? null : { tag: element.localName, text: element.textContent };
    }, `#${id}`);

    await page.waitForFunction(() => document.querySelector("#first")?.localName === "output");
    const beforeLink = await rendered("waiting");
    await page.evaluate(() => {
      const link = document.createElement("link");
      link.rel = "component";
      link.setAttribute("href", "/late.html");
      document.head.append(link);
    });
    await page.waitForFunction(() => document.querySelector("#waiting")?.localName === "output");
    await page.evaluate(() => {
      const fresh = document.createElement("x-late");
      fresh.id = "fresh";
      document.body.append(fresh);
    });
    await page.waitForFunction(() => document.querySelector("#fresh")?.localName === "output");
    const result = {
      first: await rendered("first"),
      beforeLink,
      waiting: await rendered("waiting"),
      fresh: await rendered("fresh"),
      errors,
    };
    await page.close();
    assert.deepEqual(result, {
      first: { tag: "output", text: "first shared" },
      beforeLink: { tag: "x-late", text: "" },
      // x-late shares x-shared with the first root; only its new definition is added.
      waiting: { tag: "output", text: "late shared" },
      fresh: { tag: "output", text: "late shared" },
      errors: [],
    });
  });

  it("loads a mapped live graph and lazily connects its default-export controller", async () => {
    const page = await browser.newPage();
    const serve = async (route: Route) => {
      const url = route.request().url();
      if (url.endsWith("/ui/app.html")) {
        await route.fulfill({
          contentType: "text/html",
          headers: { "access-control-allow-origin": "*" },
          body:
            `<template component="x-app" status="early" summary="App." controller="./app.js">` +
            `<defs><state type="number" name="count" value="1"></state>` +
            `</defs>` +
            `<main><button $ref="button">add</button><output $value="$count"></output></main></template>`,
        });
      } else if (url.endsWith("/ui/app.js")) {
        await route.fulfill({
          contentType: "text/javascript",
          headers: { "access-control-allow-origin": "*" },
          body:
            `export default (host) => { host.on("connect", () => {` +
            ` const add = () => { host.state.count += 1; };` +
            ` host.refs.button.addEventListener("click", add);` +
            ` const stop = host.effect(() => { host.root.dataset.count = host.state.count; });` +
            ` return () => { stop(); host.refs.button.removeEventListener("click", add); };` +
            ` }); host.on("focus-request", () => { host.refs.button.focus(); }); };`,
        });
      } else {
        await route.fulfill({
          contentType: "text/html",
          body:
            `<script type="importmap">{"imports":{"@ui/":"https://components.example/ui/"}}</script>` +
            `<link rel="component" href="@ui/app.html"><x-app id="app"></x-app>`,
        });
      }
    };
    await page.route("https://app.example/**", serve);
    await page.route("https://components.example/**", serve);
    await page.goto("https://app.example/");
    await page.addScriptTag({ path: bundlePath });
    const result = await page.evaluate(async () => {
      const api = (window as unknown as {
        HtmlNextLoader: { startBrowserComponents(): Promise<{ stop(): void }> };
      }).HtmlNextLoader;
      const started = await api.startBrowserComponents();
      for (let attempt = 0; attempt < 50 && !document.querySelector("#app")?.hasAttribute("data-count"); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const root = document.querySelector("#app")!;
      root.querySelector("button")!.click();
      await Promise.resolve();
      root.dispatchEvent(new Event("focus-request"));
      const value = {
        tag: root.localName,
        count: root.querySelector("output")!.textContent,
        effectCount: (root as HTMLElement).dataset.count,
        focused: document.activeElement === root.querySelector("button"),
      };
      started.stop();
      return value;
    });
    await page.close();
    assert.deepEqual(result, { tag: "main", count: "2", effectCount: "2", focused: true });
  });

  it("does not invoke a controller whose module resolves after disconnection", async () => {
    const page = await browser.newPage();
    let controllerRequested!: () => void;
    const requested = new Promise<void>((resolve) => { controllerRequested = resolve; });
    let releaseController!: () => void;
    const released = new Promise<void>((resolve) => { releaseController = resolve; });
    await page.route("https://delayed.example/**", async (route) => {
      const url = route.request().url();
      if (url.endsWith("/delayed.html")) {
        await route.fulfill({
          contentType: "text/html",
          body: `<template component="x-delayed" status="early" summary="Delayed." controller="./delayed.js"><main>ready</main></template>`,
        });
      } else if (url.endsWith("/delayed.js")) {
        controllerRequested();
        await released;
        await route.fulfill({
          contentType: "text/javascript",
          body:
            `window.moduleLoads = (window.moduleLoads ?? 0) + 1;` +
            `export default ({ effect }) => {` +
            ` window.controllerRuns = (window.controllerRuns ?? 0) + 1;` +
            ` effect(() => { window.effectRuns = (window.effectRuns ?? 0) + 1; });` +
            `};`,
        });
      } else {
        await route.fulfill({
          contentType: "text/html",
          body:
            `<link rel="component" href="/delayed.html">` +
            `<x-delayed id="delayed"></x-delayed>`,
        });
      }
    });
    await page.goto("https://delayed.example/");
    await page.addScriptTag({ path: bundlePath });
    await page.evaluate(async () => {
      const api = (window as unknown as {
        HtmlNextLoader: { startBrowserComponents(): Promise<{ stop(): void }> };
      }).HtmlNextLoader;
      (window as unknown as { started: { stop(): void } }).started = await api.startBrowserComponents();
    });
    await requested;
    await page.evaluate(async () => {
      const root = document.querySelector("#delayed")!;
      (window as unknown as { detachedRoot: Element }).detachedRoot = root;
      root.remove();
      await new Promise((resolve) => setTimeout(resolve));
    });
    releaseController();
    await page.waitForFunction(() => (window as unknown as { moduleLoads?: number }).moduleLoads === 1);
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve)));
    const whileDisconnected = await page.evaluate(() => ({
      controllerRuns: (window as unknown as { controllerRuns?: number }).controllerRuns ?? 0,
      effectRuns: (window as unknown as { effectRuns?: number }).effectRuns ?? 0,
    }));
    await page.evaluate(() => {
      const task = window as unknown as {
        detachedRoot: Element;
        started: { stop(): void };
      };
      document.body.append(task.detachedRoot);
    });
    await page.waitForFunction(() => (window as unknown as { effectRuns?: number }).effectRuns !== undefined);
    const afterReconnect = await page.evaluate(() => {
      const task = window as unknown as {
        controllerRuns?: number;
        effectRuns?: number;
        started: { stop(): void };
      };
      const value = {
        controllerRuns: task.controllerRuns ?? 0,
        effectRuns: task.effectRuns ?? 0,
      };
      task.started.stop();
      return value;
    });
    await page.close();
    assert.deepEqual(whileDisconnected, { controllerRuns: 0, effectRuns: 0 });
    assert.deepEqual(afterReconnect, { controllerRuns: 1, effectRuns: 1 });
  });

  it("loads same-origin components and rejects unmapped cross-origin roots", async () => {
    const sameOriginPage = await browser.newPage();
    await sameOriginPage.route("https://app.example/**", async (route) => {
      const url = route.request().url();
      if (url.endsWith("/same.html")) {
        await route.fulfill({
          contentType: "text/html",
          body:
            `<template component="x-same" status="early" summary="Same." controller="./same.js">` +
            `<main>same origin</main></template>`,
        });
      } else if (url.endsWith("/same.js")) {
        await route.fulfill({
          contentType: "text/javascript",
          body: `export default (host) => { host.root.dataset.controller = "ran"; };`,
        });
      } else {
        await route.fulfill({
          contentType: "text/html",
          body: `<link rel="component" href="/same.html"><x-same id="same"></x-same>`,
        });
      }
    });
    await sameOriginPage.goto("https://app.example/");
    await sameOriginPage.addScriptTag({ path: bundlePath });
    const sameOrigin = await sameOriginPage.evaluate(async () => {
      const api = (window as unknown as {
        HtmlNextLoader: { startBrowserComponents(): Promise<{ stop(): void }> };
      }).HtmlNextLoader;
      const started = await api.startBrowserComponents();
      for (
        let attempt = 0;
        attempt < 50 && !document.querySelector("#same")?.hasAttribute("data-controller");
        attempt += 1
      ) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const root = document.querySelector("#same")!;
      const value = {
        tag: root.localName,
        text: root.textContent,
        controller: (root as HTMLElement).dataset.controller,
      };
      started.stop();
      return value;
    });
    await sameOriginPage.close();

    let remoteComponentRequests = 0;
    let remoteControllerRequests = 0;
    const crossOriginPage = await browser.newPage();
    const serve = async (route: Route) => {
      const url = route.request().url();
      if (url === "https://components.example/remote.html") {
        remoteComponentRequests += 1;
        await route.fulfill({
          contentType: "text/html",
          headers: { "access-control-allow-origin": "*" },
          body:
            `<template component="x-remote" status="early" summary="Remote." controller="./remote.js">` +
            `<main>remote</main></template>`,
        });
      } else if (url === "https://components.example/remote.js") {
        remoteControllerRequests += 1;
        await route.fulfill({
          contentType: "text/javascript",
          headers: { "access-control-allow-origin": "*" },
          body: `globalThis.remoteControllerRan = true; export default () => {};`,
        });
      } else {
        await route.fulfill({
          contentType: "text/html",
          body:
            `<link rel="component" href="https://components.example/remote.html">` +
            `<x-remote id="remote"></x-remote>`,
        });
      }
    };
    await crossOriginPage.route("https://app.example/**", serve);
    await crossOriginPage.route("https://components.example/**", serve);
    await crossOriginPage.goto("https://app.example/untrusted");
    await crossOriginPage.addScriptTag({ path: bundlePath });
    const crossOrigin = await crossOriginPage.evaluate(async () => {
      const api = (window as unknown as {
        HtmlNextLoader: { startBrowserComponents(): Promise<{ stop(): void }> };
      }).HtmlNextLoader;
      let error = "none";
      try {
        await api.startBrowserComponents();
      } catch (caught) {
        error = (caught as { diagnostic?: { code?: string } }).diagnostic?.code ?? "unknown";
      }
      return {
        error,
        rendered: document.querySelector("#remote")?.localName !== "x-remote",
        controllerRan: (globalThis as typeof globalThis & { remoteControllerRan?: boolean })
          .remoteControllerRan === true,
      };
    });
    await crossOriginPage.close();

    assert.deepEqual(sameOrigin, {
      tag: "main",
      text: "same origin",
      controller: "ran",
    });
    assert.deepEqual(crossOrigin, {
      error: "HL010",
      rendered: false,
      controllerRan: false,
    });
    assert.equal(remoteComponentRequests, 0);
    assert.equal(remoteControllerRequests, 0);
  });

  it("keeps declarative output connected when a controller module is invalid", async () => {
    const page = await browser.newPage();
    await page.route("https://bad.example/**", async (route) => {
      const url = route.request().url();
      if (url.endsWith("/bad.html")) {
        await route.fulfill({
          contentType: "text/html",
          body: `<template component="x-bad" status="early" summary="Bad." controller="./bad.js"><main>still here</main></template>`,
        });
      } else if (url.endsWith("/bad.js")) {
        await route.fulfill({ contentType: "text/javascript", body: `export default 42;` });
      } else {
        await route.fulfill({
          contentType: "text/html",
          body:
            `<script type="importmap">{"imports":{"@bad/":"https://bad.example/"}}</script>` +
            `<link rel="component" href="@bad/bad.html"><x-bad id="bad"></x-bad>`,
        });
      }
    });
    await page.goto("https://bad.example/");
    await page.addScriptTag({ path: bundlePath });
    const result = await page.evaluate(async () => {
      const errors: string[] = [];
      const api = (window as unknown as {
        HtmlNextLoader: {
          startBrowserComponents(
            root?: Document,
            options?: { onError(error: unknown): void },
          ): Promise<{ stop(): void }>;
        };
      }).HtmlNextLoader;
      const started = await api.startBrowserComponents(document, {
        onError(error) {
          errors.push((error as { diagnostic?: { code?: string } }).diagnostic?.code ?? "unknown");
        },
      });
      for (let attempt = 0; attempt < 50 && errors.length === 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const root = document.querySelector("#bad")!;
      const value = { tag: root.localName, text: root.textContent, errors };
      started.stop();
      return value;
    });
    await page.close();
    assert.deepEqual(result, { tag: "main", text: "still here", errors: ["HJ002"] });
  });
});
