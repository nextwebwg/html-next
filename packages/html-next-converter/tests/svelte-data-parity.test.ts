import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, it } from "vitest";

import { build } from "esbuild";
import { sveltePlugin } from "./helpers/svelte.js";
import { chromium, firefox, webkit, type BrowserType, type Page } from "playwright";

import { convertComponents } from "../src/index.js";
import { assertPixelsEqual, launchParityBrowser } from "../../html-next/tests/pixel-parity.js";

const enabled = process.env.HTMLNEXT_TARGET_TEST === "1";
import { dataLifecycleSource as source } from "./fixtures/data-lifecycle.js";

const sampledSource = `<template component="x-data-cycle" status="early" summary="Sampled resource."><defs>
  <state name="page" type="number" value="1"></state><state name="kind" value="Before"></state>
  <computed name="requestPage" from="page + 1"></computed>
  <data name="feed" src="./api/{kind}" type="string" debounce="80ms" poll="500ms">
    <param name="page" from:value="requestPage"></param><param name="kind" expr:value="kind"></param>
    <param name="tag" expr:value="['a', 'b']"></param></data>
  <handler name="sample"><set name="kind" expr:value="kind = 'Before' ? 'After' : 'Before'"></set></handler>
  <handler name="next"><set name="page" expr:value="page + 1"></set></handler>
  </defs><section><button class="sample" on:click="sample">Sample</button><button class="next" on:click="next">Next</button>
    <output class="label" $value="feed.value"></output><output class="pending" $value="feed.pending"></output></section></template>`;

async function snapshot(page: Page) {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  return {
    behavior: await page.locator("#case").evaluate((root) => Object.fromEntries(
      ["label", "pending", "ok", "failed"].map((name) => [name, root.querySelector(`.${name}`)?.textContent]),
    )),
    pixels: await page.locator("#case").screenshot({ animations: "disabled" }),
  };
}

describe.skipIf(!enabled)("Svelte declared data parity", () => {
  let directory = "";
  let liveBundle = "";
  const samples = new Map<"application" | "library", { bundle: string; markup: string; css: string }>();
  const outputs = new Map<"application" | "library", { bundle: string; markup: string; css: string }>();

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-svelte-data-parity-"));
    await symlink(fileURLToPath(new URL("../node_modules", import.meta.url)), join(directory, "node_modules"), "dir");
    await mkdir(join(directory, "components"));
    await writeFile(join(directory, "components/cycle.html"), source);
    liveBundle = join(directory, "live.js");
    await build({
      entryPoints: [fileURLToPath(new URL("../../html-next/src/live.ts", import.meta.url))],
      outfile: liveBundle, bundle: true, format: "iife", globalName: "HtmlRuntime", platform: "browser", target: ["es2022"],
    });
    const compileScene = async (kind: string, authored: string, results: typeof outputs): Promise<void> => {
    await writeFile(join(directory, "components/cycle.html"), authored);
    for (const mode of ["application", "library"] as const) {
      const outDirectory = join(directory, kind, mode);
      const manifest = await convertComponents({
        mode, target: "svelte", root: directory, outDirectory, entries: ["components/**"], publicRootURL: "/app/",
      });
      const css = (await Promise.all(manifest.output.artifacts.filter((artifact) => artifact.kind === "style")
        .map((artifact) => readFile(join(outDirectory, artifact.path), "utf8")))).join("\n");
      const component = manifest.components[0]!;
      const app = join(outDirectory, "App.svelte");
      await writeFile(app, `<script>import XDataCycle from "./${component.artifact}";</script><XDataCycle id="case" />`);
      const mountEntry = join(outDirectory, "mount.ts");
      await writeFile(mountEntry, `import { mount, hydrate, unmount } from "svelte";
import App from "./App.svelte";
const target = document.querySelector("main")!;
const instance = target.hasChildNodes() ? hydrate(App, { target }) : mount(App, { target });
(window as any).svelteRoot = { unmount: () => unmount(instance) };`);
      const bundle = join(outDirectory, "mount.js");
      await build({
        entryPoints: [mountEntry], outfile: bundle, bundle: true, format: "iife", platform: "browser",
        target: ["es2022"], loader: { ".css": "empty" }, plugins: [sveltePlugin("client")],
      });
      const serverEntry = join(outDirectory, "server.ts");
      const serverBundle = join(outDirectory, "server.mjs");
      await writeFile(serverEntry, `import { render } from "svelte/server"; import App from "./App.svelte"; export const html = render(App).body;`);
      await build({ entryPoints: [serverEntry], outfile: serverBundle, bundle: true, format: "esm", platform: "node",
        packages: "external", loader: { ".css": "empty" }, plugins: [sveltePlugin("server")] });
      const markup = (await import(pathToFileURL(serverBundle).href) as { html: string }).html;
      assert.match(markup, /<output class="pending">true<\/output>/);
      results.set(mode, { bundle, markup, css });
    }
    };
    await compileScene("lifecycle", source, outputs);
    await compileScene("sampled", sampledSource, samples);
  }, 60_000);

  afterAll(async () => { if (directory !== "") await rm(directory, { recursive: true, force: true }); });

  for (const [engine, browserType] of [["Chromium", chromium], ["Firefox", firefox], ["WebKit", webkit]] as const satisfies ReadonlyArray<readonly [string, BrowserType]>) {
    for (const mode of ["application", "library"] as const) {
      it(`${engine} ${mode} samples request-only parameters at send and polling without subscribing`, async () => {
        const browser = await launchParityBrowser(browserType);
        const pages: Page[] = [];
        const output = samples.get(mode)!;
        const requests = { live: [] as string[], svelte: [] as string[] };
        const errors: string[] = [];
        try {
          for (const kind of ["live", "svelte"] as const) {
            const page = await browser.newPage(); pages.push(page);
            page.on("pageerror", (error) => errors.push(error.message));
            await page.route("https://app.example/**", async (route) => {
              if (route.request().resourceType() === "document") {
                await route.fulfill({ contentType: "text/html", body: kind === "live"
                  ? `${sampledSource}<main><x-data-cycle id="case"></x-data-cycle></main>` : `<style>${output.css}</style><main>${output.markup}</main>` });
                return;
              }
              const url = new URL(route.request().url());
              const label = `${url.pathname}${url.search}`;
              requests[kind].push(label);
              await route.fulfill({ contentType: "text/plain", body: label });
            });
            await page.goto(`https://app.example/app/components/${kind === "live" ? "cycle.html" : "svelte"}`);
          }
          await pages[0]!.addScriptTag({ path: liveBundle });
          await pages[0]!.evaluate(() => window.HtmlRuntime.lowerDocument());
          await pages[1]!.addScriptTag({ path: output.bundle });
          await Promise.all(pages.map((page) => page.evaluate(() => document.querySelector<HTMLButtonElement>("button.sample")!.click())));
          const waitFor = async (label: string) => Promise.all(pages.map((page) => page.waitForFunction((expected) =>
            document.querySelector("#case .label")?.textContent === expected, label, { timeout: 5000 })));
          await waitFor("/app/components/api/After?page=2&tag=a&tag=b");
          assert.deepEqual(requests.svelte, requests.live);
          await Promise.all(pages.map((page) => page.locator("button.sample").click()));
          const counts = { live: requests.live.length, svelte: requests.svelte.length };
          await new Promise((resolve) => setTimeout(resolve, 120));
          assert.deepEqual({ live: requests.live.length, svelte: requests.svelte.length }, counts, "sample-only writes do not trigger reads");
          await waitFor("/app/components/api/Before?page=2&tag=a&tag=b");
          await Promise.all(pages.map((page) => page.evaluate(() => {
            const button = document.querySelector<HTMLButtonElement>("button.next")!; button.click(); button.click();
          })));
          await waitFor("/app/components/api/Before?page=4&tag=a&tag=b");
          assert.ok(requests.svelte.every((url) => !url.includes("?page=3")), "debounce sends only the latest reactive inputs");
          assert.deepEqual(requests.svelte, requests.live);
          assert.deepEqual(errors, []);
        } finally {
          try { await Promise.all(pages.map((page) => page.close())); }
          finally { await browser.close(); }
        }
      });

      it(`${engine} ${mode} matches SSR hydration, computed parameters, errors, polling, and pixels`, async () => {
        const browser = await launchParityBrowser(browserType);
        const pages: Page[] = [];
        const errors: string[] = [];
        const requests = { live: [] as string[], svelte: [] as string[] };
        try {
          const live = await browser.newPage();
          pages.push(live);
          const svelte = await browser.newPage();
          pages.push(svelte);
          for (const [page, kind] of [[live, "live"], [svelte, "svelte"]] as const) {
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
          await Promise.all([live.goto("https://app.example/app/components/cycle.html"), svelte.goto("https://app.example/app/svelte")]);
          assert.deepEqual(requests.svelte, [], "server rendering must not start a browser request");
          await live.addScriptTag({ path: liveBundle });
          await live.evaluate(() => window.HtmlRuntime.lowerDocument());
          await svelte.addScriptTag({ path: outputs.get(mode)!.bundle });
          const waitFor = async (label: string, failed: string) => Promise.all([live, svelte].map((page) =>
            page.waitForFunction(([expectedLabel, expectedFailure]) => {
              const root = document.querySelector("#case");
              return root?.querySelector(".label")?.textContent === expectedLabel &&
                root?.querySelector(".failed")?.textContent === expectedFailure;
            }, [label, failed], { timeout: 5000 })));
          const compare = async (stage: string) => {
            const [native, converted] = await Promise.all([snapshot(live), snapshot(svelte)]);
            assert.deepEqual(converted.behavior, native.behavior, `${stage} data behavior differs`);
            await assertPixelsEqual(svelte, converted.pixels, native.pixels, `${stage} data pixels differ`, live);
          };
          await waitFor("Second", "no");
          await compare("loaded");
          await Promise.all([live, svelte].map((page) => page.locator("#case button").click()));
          await waitFor("Second", "yes");
          await compare("failed");
          await Promise.all([live, svelte].map((page) => page.waitForFunction(() =>
            document.querySelector("#case .failed")?.textContent === "no")));
          await compare("invalid typed response");
          await waitFor("Recovered", "no");
          await compare("polled");
          for (const record of [requests.live, requests.svelte]) {
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
      const requests = { live: [] as string[], svelte: [] as string[] };
      let releaseStale!: () => void;
      const held = new Promise<void>((resolve) => { releaseStale = resolve; });
      let reportBoth!: () => void;
      const bothHeld = new Promise<void>((resolve) => { reportBoth = resolve; });
      let staleCount = 0;
      try {
        const live = await browser.newPage();
        pages.push(live);
        const svelte = await browser.newPage();
        pages.push(svelte);
        for (const [page, kind] of [[live, "live"], [svelte, "svelte"]] as const) {
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
        await Promise.all([live.goto("https://app.example/app/components/cycle.html"), svelte.goto("https://app.example/app/svelte")]);
        await live.addScriptTag({ path: liveBundle });
        await live.evaluate(() => (window.HtmlRuntime as typeof window.HtmlRuntime & { observeDocument(): () => void }).observeDocument());
        await svelte.addScriptTag({ path: output.bundle });
        const waitFor = async (label: string) => Promise.all([live, svelte].map((page) => page.waitForFunction((expected) =>
          document.querySelector("#case .label")?.textContent === expected, label, { timeout: 5000 })));
        await waitFor("Second");
        await Promise.all([live, svelte].map((page) => page.locator("#case button").click()));
        await bothHeld;
        await Promise.all([live, svelte].map((page) => page.locator("#case button").click()));
        await waitFor("Fourth");
        releaseStale();
        await Promise.all([live, svelte].map((page) => page.waitForTimeout(50)));
        assert.deepEqual((await snapshot(svelte)).behavior, (await snapshot(live)).behavior);
        assert.equal(await svelte.locator("#case .label").textContent(), "Fourth");
        await Promise.all([
          live.evaluate(() => document.querySelector("#case")?.remove()),
          svelte.evaluate(() => (window as unknown as { svelteRoot: { unmount(): void } }).svelteRoot.unmount()),
        ]);
        await Promise.all([live, svelte].map((page) => page.waitForTimeout(50)));
        const count = { live: requests.live.length, svelte: requests.svelte.length };
        await new Promise((resolve) => setTimeout(resolve, 1700));
        assert.deepEqual({ live: requests.live.length, svelte: requests.svelte.length }, count, "disposed reads must stop polling");
        assert.deepEqual(errors, []);
      } finally {
        releaseStale();
        try { await Promise.all(pages.map((page) => page.close())); }
        finally { await browser.close(); }
      }
    });
  }
});
