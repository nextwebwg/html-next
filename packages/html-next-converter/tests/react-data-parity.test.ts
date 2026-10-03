import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, it } from "vitest";

import { build } from "esbuild";
import { createElement, type ComponentType } from "react";
import { renderToString } from "react-dom/server";
import { chromium, firefox, webkit, type BrowserType, type Page } from "playwright";

import { convertComponents } from "../src/index.js";
import { assertPixelsEqual, launchParityBrowser } from "../../html-next/tests/pixel-parity.js";

const enabled = process.env.HTMLNEXT_TARGET_TEST === "1";
const source = `<template component="x-data-cycle" status="early" summary="Data lifecycle."><defs>
  <state type="number" name="page" value="1"></state>
  <computed name="requestPage" from="page + 1"></computed>
  <data name="feed" src="./api/feed" type="object({ label: string })" debounce="20ms" poll="1500ms">
    <param name="page" from:value="requestPage"></param>
  </data>
  <handler name="next"><set name="page" expr:value="page + 1"></set></handler>
</defs><section><button type="button" on:click="next">Next</button>
  <output class="label" $value="feed.value.label"></output>
  <output class="pending" $value="feed.pending"></output>
  <output class="ok" $value="feed.ok"></output>
  <output class="failed" $value="feed.error ? 'yes' : 'no'"></output>
</section><style>:host { display: block; background: rgb(238 244 250); padding: 4px; }</style></template>`;

async function snapshot(page: Page) {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  return {
    behavior: await page.locator("#case").evaluate((root) => Object.fromEntries(
      ["label", "pending", "ok", "failed"].map((name) => [name, root.querySelector(`.${name}`)?.textContent]),
    )),
    pixels: await page.locator("#case").screenshot({ animations: "disabled" }),
  };
}

describe.skipIf(!enabled)("React declared data parity", () => {
  let directory = "";
  let liveBundle = "";
  const outputs = new Map<"application" | "library", { bundle: string; markup: string; css: string }>();

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-react-data-parity-"));
    await mkdir(join(directory, "components"));
    await writeFile(join(directory, "components/cycle.html"), source);
    liveBundle = join(directory, "live.js");
    await build({
      entryPoints: [fileURLToPath(new URL("../../html-next/src/live.ts", import.meta.url))],
      outfile: liveBundle, bundle: true, format: "iife", globalName: "HtmlRuntime", platform: "browser", target: ["es2022"],
    });
    for (const mode of ["application", "library"] as const) {
      const outDirectory = join(directory, mode);
      const manifest = await convertComponents({
        mode, target: "react", root: directory, outDirectory, entries: ["components/**"], publicRootURL: "/app/",
      });
      const css = (await Promise.all(manifest.output.artifacts.filter((artifact) => artifact.kind === "style")
        .map((artifact) => readFile(join(outDirectory, artifact.path), "utf8")))).join("\n");
      const mountEntry = join(outDirectory, "mount.tsx");
      await writeFile(mountEntry, `import React from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import { XDataCycle } from "./${manifest.output.entry.replace(/\.ts$/, "")}";
const mount = document.querySelector("main")!;
const element = <XDataCycle id="case" />;
const hydrated = mount.hasChildNodes();
const root = hydrated ? hydrateRoot(mount, element) : createRoot(mount);
if (!hydrated) root.render(element);
(window as any).reactRoot = root;`);
      const bundle = join(outDirectory, "mount.js");
      await build({
        entryPoints: [mountEntry], outfile: bundle, bundle: true, format: "iife", platform: "browser",
        target: ["es2022"], jsx: "automatic", loader: { ".css": "empty" },
        nodePaths: [fileURLToPath(new URL("../node_modules", import.meta.url))],
      });
      const server = await build({
        entryPoints: [join(outDirectory, manifest.output.entry)], bundle: true, write: false,
        platform: "node", format: "cjs", jsx: "automatic", packages: "external", loader: { ".css": "empty" },
      });
      const module = { exports: {} as Record<string, ComponentType<Record<string, unknown>>> };
      new Function("require", "module", "exports", server.outputFiles[0]!.text)(createRequire(import.meta.url), module, module.exports);
      const markup = renderToString(createElement(module.exports.XDataCycle!, { id: "case" }));
      assert.match(markup, /<output class="pending">true<\/output>/);
      outputs.set(mode, { bundle, markup, css });
    }
  }, 60_000);

  afterAll(async () => { if (directory !== "") await rm(directory, { recursive: true, force: true }); });

  for (const [engine, browserType] of [["Chromium", chromium], ["Firefox", firefox], ["WebKit", webkit]] as const satisfies ReadonlyArray<readonly [string, BrowserType]>) {
    for (const mode of ["application", "library"] as const) {
      it(`${engine} ${mode} matches SSR hydration, computed parameters, errors, polling, and pixels`, async () => {
        const browser = await launchParityBrowser(browserType);
        const pages: Page[] = [];
        const errors: string[] = [];
        const requests = { live: [] as string[], react: [] as string[] };
        try {
          const live = await browser.newPage();
          pages.push(live);
          const react = await browser.newPage();
          pages.push(react);
          for (const [page, kind] of [[live, "live"], [react, "react"]] as const) {
            page.on("pageerror", (error) => errors.push(error.message));
            await page.route("https://app.example/**", async (route) => {
              if (route.request().resourceType() === "document") {
                await route.fulfill({ contentType: "text/html", body: page === live
                  ? `${source}<main><x-data-cycle id="case"></x-data-cycle></main>`
                  : `<style>${outputs.get(mode)!.css}</style><main>${outputs.get(mode)!.markup}</main>` });
                return;
              }
              const url = new URL(route.request().url());
              requests[kind].push(`${url.pathname}${url.search}`);
              const pageNumber = url.searchParams.get("page");
              const pageThreeReads = requests[kind].filter((request) => request.endsWith("?page=3")).length;
              const failed = pageNumber === "3" && pageThreeReads === 1;
              await route.fulfill({
                status: failed ? 503 : 200, contentType: "application/json",
                body: failed ? "unavailable" : JSON.stringify({ label: pageNumber === "2" ? "Second" : pageThreeReads === 2 ? 42 : "Recovered" }),
              });
            });
          }
          await Promise.all([live.goto("https://app.example/app/components/cycle.html"), react.goto("https://app.example/app/react")]);
          assert.deepEqual(requests.react, [], "server rendering must not start a browser request");
          await live.addScriptTag({ path: liveBundle });
          await live.evaluate(() => window.HtmlRuntime.lowerDocument());
          await react.addScriptTag({ path: outputs.get(mode)!.bundle });
          const waitFor = async (label: string, failed: string) => Promise.all([live, react].map((page) =>
            page.waitForFunction(([expectedLabel, expectedFailure]) => {
              const root = document.querySelector("#case");
              return root?.querySelector(".label")?.textContent === expectedLabel &&
                root?.querySelector(".failed")?.textContent === expectedFailure;
            }, [label, failed], { timeout: 5000 })));
          const compare = async (stage: string) => {
            const [native, converted] = await Promise.all([snapshot(live), snapshot(react)]);
            assert.deepEqual(converted.behavior, native.behavior, `${stage} data behavior differs`);
            await assertPixelsEqual(react, converted.pixels, native.pixels, `${stage} data pixels differ`, live);
          };
          await waitFor("Second", "no");
          await compare("loaded");
          await Promise.all([live, react].map((page) => page.locator("#case button").click()));
          await waitFor("Second", "yes");
          await compare("failed");
          await Promise.all([live, react].map((page) => page.waitForFunction(() =>
            document.querySelector("#case .failed")?.textContent === "no")));
          await compare("invalid typed response");
          await waitFor("Recovered", "no");
          await compare("polled");
          for (const record of [requests.live, requests.react]) {
            assert.equal(record[0], "/app/components/api/feed?page=2");
            assert.ok(record.filter((request) => request.endsWith("?page=3")).length >= 2);
          }
          assert.deepEqual(errors, []);
        } finally {
          try { await Promise.all(pages.map((page) => page.close())); }
          finally { await browser.close(); }
        }
      });
    }

    it(`${engine} cancels stale data and stops polling after disposal`, async () => {
      const browser = await launchParityBrowser(browserType);
      const pages: Page[] = [];
      const output = outputs.get("application")!;
      const errors: string[] = [];
      const requests = { live: [] as string[], react: [] as string[] };
      let releaseStale!: () => void;
      const held = new Promise<void>((resolve) => { releaseStale = resolve; });
      let reportBoth!: () => void;
      const bothHeld = new Promise<void>((resolve) => { reportBoth = resolve; });
      let staleCount = 0;
      try {
        const live = await browser.newPage();
        pages.push(live);
        const react = await browser.newPage();
        pages.push(react);
        for (const [page, kind] of [[live, "live"], [react, "react"]] as const) {
          page.on("pageerror", (error) => errors.push(error.message));
          await page.route("https://app.example/**", async (route) => {
            if (route.request().resourceType() === "document") {
              await route.fulfill({ contentType: "text/html", body: page === live
                ? `${source}<main><x-data-cycle id="case"></x-data-cycle></main>`
                : `<style>${output.css}</style><main>${output.markup}</main>` });
              return;
            }
            const url = new URL(route.request().url());
            const pageNumber = url.searchParams.get("page");
            requests[kind].push(`${url.pathname}${url.search}`);
            if (pageNumber === "3") {
              staleCount += 1;
              if (staleCount === 2) reportBoth();
              await held;
              try { await route.fulfill({ contentType: "application/json", body: JSON.stringify({ label: "STALE" }) }); }
              catch { /* The newer request may have aborted this one. */ }
              return;
            }
            await route.fulfill({ contentType: "application/json", body: JSON.stringify({ label: pageNumber === "2" ? "Second" : "Fourth" }) });
          });
        }
        await Promise.all([live.goto("https://app.example/app/components/cycle.html"), react.goto("https://app.example/app/react")]);
        await live.addScriptTag({ path: liveBundle });
        await live.evaluate(() => (window.HtmlRuntime as typeof window.HtmlRuntime & { observeDocument(): () => void }).observeDocument());
        await react.addScriptTag({ path: output.bundle });
        const waitFor = async (label: string) => Promise.all([live, react].map((page) => page.waitForFunction((expected) =>
          document.querySelector("#case .label")?.textContent === expected, label, { timeout: 5000 })));
        await waitFor("Second");
        await Promise.all([live, react].map((page) => page.locator("#case button").click()));
        await bothHeld;
        await Promise.all([live, react].map((page) => page.locator("#case button").click()));
        await waitFor("Fourth");
        releaseStale();
        await Promise.all([live, react].map((page) => page.waitForTimeout(50)));
        assert.deepEqual((await snapshot(react)).behavior, (await snapshot(live)).behavior);
        assert.equal(await react.locator("#case .label").textContent(), "Fourth");
        await Promise.all([
          live.evaluate(() => document.querySelector("#case")?.remove()),
          react.evaluate(() => (window as unknown as { reactRoot: { unmount(): void } }).reactRoot.unmount()),
        ]);
        await Promise.all([live, react].map((page) => page.waitForTimeout(50)));
        const count = { live: requests.live.length, react: requests.react.length };
        await new Promise((resolve) => setTimeout(resolve, 1700));
        assert.deepEqual({ live: requests.live.length, react: requests.react.length }, count, "disposed reads must stop polling");
        assert.deepEqual(errors, []);
      } finally {
        releaseStale();
        try { await Promise.all(pages.map((page) => page.close())); }
        finally { await browser.close(); }
      }
    });
  }
});
