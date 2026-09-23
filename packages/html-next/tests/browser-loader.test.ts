import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";

import { build } from "esbuild";
import { chromium, type Browser, type Route } from "playwright";

const enabled = process.env.HTMLNEXT_BROWSER_TEST === "1";
const browserLoaderUrl = new URL("../src/browser-loader.ts", import.meta.url);
const browserDistributableUrl = new URL("../src/browser.ts", import.meta.url);

describe.skipIf(!enabled)("browser graph loader", () => {
  let browser: Browser;
  let bundlePath = "";
  let bundleInputs: readonly string[] = [];
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

  it("starts the linkable browser distributable when the module executes", async () => {
    const page = await browser.newPage();
    const distributablePath = join(temporaryDirectory, "browser.js");
    await build({
      entryPoints: [browserDistributableUrl.pathname],
      bundle: true,
      format: "esm",
      outfile: distributablePath,
      platform: "browser",
      target: ["es2022"],
    });
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
        tag: document.querySelector("#ready")?.localName,
        text: document.querySelector("#ready")?.textContent,
      };
    });
    await page.close();
    assert.deepEqual(result, { exposed: true, tag: "output", text: "ready" });
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
            `<defs><state name="count" :value="1"></state>` +
            `<method name="focusInput" export="focusInput" returns="promise(undefined)"></method></defs>` +
            `<main><button $ref="button">add</button><output $value="count"></output></main></template>`,
        });
      } else if (url.endsWith("/ui/app.js")) {
        await route.fulfill({
          contentType: "text/javascript",
          headers: { "access-control-allow-origin": "*" },
          body:
            `export default (host) => {` +
            ` const add = () => { host.state.count += 1; };` +
            ` host.refs.button.addEventListener("click", add);` +
            ` const stop = host.effect(() => { host.element.dataset.count = host.state.count; });` +
            ` return () => { stop(); host.refs.button.removeEventListener("click", add); };` +
            `}; export const focusInput = (host) => { host.refs.button.dataset.focused = "yes"; };`,
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
      await (root as Element & { focusInput(): Promise<void> }).focusInput();
      const value = {
        tag: root.localName,
        count: root.querySelector("output")!.textContent,
        effectCount: (root as HTMLElement).dataset.count,
        methodCalled: (root.querySelector("button") as HTMLElement).dataset.focused,
      };
      started.stop();
      return value;
    });
    await page.close();
    assert.deepEqual(result, { tag: "main", count: "2", effectCount: "2", methodCalled: "yes" });
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
          body: `export default (host) => { host.element.dataset.controller = "ran"; };`,
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
