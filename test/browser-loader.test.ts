import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { build } from "esbuild";
import { chromium, type Browser } from "playwright";

const enabled = process.env.HTMLNEXT_BROWSER_TEST === "1";
const browserLoaderUrl = new URL("../src/browser-loader.ts", import.meta.url);

describe("browser graph loader", { skip: !enabled }, () => {
  let browser: Browser;
  let bundlePath = "";
  let temporaryDirectory = "";

  before(async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "html-next-browser-loader-"));
    bundlePath = join(temporaryDirectory, "browser-loader.js");
    await build({
      entryPoints: [browserLoaderUrl.pathname],
      bundle: true,
      format: "iife",
      globalName: "HtmlNextLoader",
      outfile: bundlePath,
      platform: "browser",
      target: ["es2022"],
    });
    browser = await chromium.launch({ headless: true });
  });

  after(async () => {
    await browser?.close();
    if (temporaryDirectory !== "") await rm(temporaryDirectory, { recursive: true, force: true });
  });

  it("loads a mapped live graph and lazily connects its default-export controller", async () => {
    const page = await browser.newPage();
    await page.route("https://app.example/**", async (route) => {
      const url = route.request().url();
      if (url.endsWith("/ui/app.html")) {
        await route.fulfill({
          contentType: "text/html",
          body:
            `<template component="x-app" status="early" summary="App." controller="./app.js">` +
            `<defs><state name="count" :value="1"></state>` +
            `<method name="focusInput" export="focusInput" returns="promise(undefined)"></method></defs>` +
            `<main><button $ref="button">add</button><output $value="count"></output></main></template>`,
        });
      } else if (url.endsWith("/ui/app.js")) {
        await route.fulfill({
          contentType: "text/javascript",
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
            `<script type="importmap">{"imports":{"@ui/":"https://app.example/ui/"}}</script>` +
            `<link rel="component" href="@ui/app.html"><x-app id="app"></x-app>`,
        });
      }
    });
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
