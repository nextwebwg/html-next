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

const conformingSource = `<template component="x-data-cycle" status="early" summary="Conforming parameters."><defs>
  <state name="box" type="object({ query: number, sample: date })" value="{ query: 1, sample: '2024-02-29' }"></state>
  <data name="feed" src="./api/read" type="string" debounce="80ms" poll="600ms">
    <param name="query" from:value="box.query"></param><param name="sample" expr:value="box.sample"></param></data>
  <handler name="invalid"><set name="box" expr:value="{ query: 'bad', sample: 42 }"></set></handler>
  <handler name="partial"><set name="box" expr:value="{ query: 2, sample: 42 }"></set></handler>
  <handler name="sample"><set name="box" expr:value="{ query: 'bad', sample: '2025-01-01' }"></set></handler>
  <handler name="recover"><set name="box" expr:value="{ query: 3, sample: '2026-01-01' }"></set></handler>
  </defs><section><button class="invalid" on:click="invalid">Invalid</button><button class="partial" on:click="partial">Partial</button><button class="sample" on:click="sample">Sample</button><button class="recover" on:click="recover">Recover</button>
    <output class="label" $value="feed.value"></output><output class="pending" $value="feed.pending"></output></section></template>`;

const initiallyInvalidSource = conformingSource
  .replace('<state name="box"', '<state name="count" type="number" value="0"></state><state name="box"')
  .replace('<param name="query" from:value="box.query"></param>', '<param name="query" from:value="8px / count"></param><param name="other" from:value="box.query"></param>')
  .replace(' poll="600ms"', '')
  .replace('</defs>', '<handler name="start"><set name="count" expr:value="2"></set></handler></defs>')
  .replace('<section>', '<section><button class="start" on:click="start">Start</button>');

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
  const initial = new Map<"application" | "library", { bundle: string; markup: string; css: string }>();
  const conforming = new Map<"application" | "library", { bundle: string; markup: string; css: string }>();
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
    await compileScene("conforming", conformingSource, conforming);
    await compileScene("initial", initiallyInvalidSource, initial);
  }, 60_000);

  afterAll(async () => { if (directory !== "") await rm(directory, { recursive: true, force: true }); });

  for (const [engine, browserType] of [["Chromium", chromium], ["Firefox", firefox], ["WebKit", webkit]] as const satisfies ReadonlyArray<readonly [string, BrowserType]>) {
    for (const mode of ["application", "library"] as const) {
      it(`${engine} ${mode} seeds accepted parameters before initial recovery and restarts equal URLs`, async () => {
        const browser = await launchParityBrowser(browserType);
        const pages: Page[] = [];
        const output = initial.get(mode)!;
        const requests = { live: [] as string[], svelte: [] as string[] };
        const errors: string[] = [];
        try {
          for (const kind of ["live", "svelte"] as const) {
            const page = await browser.newPage(); pages.push(page);
            page.on("pageerror", (error) => errors.push(error.message));
            await page.route("https://app.example/**", async route => {
              if (route.request().resourceType() === "document") {
                await route.fulfill({ contentType: "text/html", body: kind === "live"
                  ? `${initiallyInvalidSource}<main><x-data-cycle id="case"></x-data-cycle></main>` : `<style>${output.css}</style><main>${output.markup}</main>` });
                return;
              }
              const url = new URL(route.request().url());
              const label = `${url.pathname}${url.search}`; requests[kind].push(label);
              await route.fulfill({ contentType: "text/plain", body: label });
            });
            await page.goto(`https://app.example/app/components/${kind === "live" ? "cycle.html" : "svelte"}`);
          }
          await pages[0]!.addScriptTag({ path: liveBundle });
          await pages[0]!.evaluate(() => window.HtmlRuntime.lowerDocument());
          await pages[1]!.addScriptTag({ path: output.bundle });
          const act = (name: string) => Promise.all(pages.map(page => page.evaluate(selector =>
            document.querySelector<HTMLButtonElement>(selector)!.click(), `button.${name}`)));
          const pending = () => Promise.all(pages.map(page => page.locator("#case .pending").textContent()));
          await new Promise(resolve => setTimeout(resolve, 150));
          assert.deepEqual(requests, { live: [], svelte: [] }, "initially invalid from parameters start no request");
          assert.deepEqual(await pending(), ["true", "true"]);
          await act("partial");
          await new Promise(resolve => setTimeout(resolve, 150));
          assert.deepEqual(requests, { live: [], svelte: [] }, "one invalid parameter does not prevent acceptance of the others");
          await act("start");
          const label = "/app/components/api/read?query=4px&other=2&sample=2024-02-29";
          const waitFor = () => Promise.all(pages.map(page => page.waitForFunction(expected =>
            document.querySelector("#case .label")?.textContent === expected && document.querySelector("#case .pending")?.textContent === "false", label, { timeout: 5000 })));
          await waitFor();
          assert.deepEqual(requests.live, [label], "native samples retain values accepted before the first valid request");
          assert.deepEqual(requests.svelte, requests.live);
          const restarted = pages.map(page => page.waitForRequest(request => request.url().endsWith(label), { timeout: 5000 }));
          await act("partial");
          await Promise.all(restarted);
          await waitFor();
          assert.deepEqual(requests.live, [label, label], "native valid updates restart even with the same URL");
          assert.deepEqual(requests.svelte, requests.live);
          assert.deepEqual(errors, []);
        } finally {
          try { await Promise.all(pages.map(page => page.close())); }
          finally { await browser.close(); }
        }
      });

      it(`${engine} ${mode} retains conforming request parameters through invalid reads and reconnects`, async () => {
        const browser = await launchParityBrowser(browserType);
        const pages: Page[] = [];
        const output = conforming.get(mode)!;
        const requests = { live: [] as string[], svelte: [] as string[] };
        const failed = { live: [] as string[], svelte: [] as string[] };
        const started = new Map<"live" | "svelte", { promise: Promise<void>; resolve: () => void }>();
        const errors: string[] = [];
        let release!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        try {
          for (const kind of ["live", "svelte"] as const) {
            const page = await browser.newPage(); pages.push(page);
            let resolve!: () => void;
            const promise = new Promise<void>((ready) => { resolve = ready; });
            started.set(kind, { promise, resolve });
            page.on("pageerror", (error) => errors.push(error.message));
            page.on("requestfailed", (request) => failed[kind].push(request.url()));
            await page.route("https://app.example/**", async (route) => {
              if (route.request().resourceType() === "document") {
                await route.fulfill({ contentType: "text/html", body: kind === "live"
                  ? `${conformingSource}<main><x-data-cycle id="case"></x-data-cycle></main>` : `<style>${output.css}</style><main>${output.markup}</main>` });
                return;
              }
              const url = new URL(route.request().url());
              const label = `${url.pathname}${url.search}`;
              requests[kind].push(label);
              const first = requests[kind].length === 1;
              if (first) { started.get(kind)!.resolve(); await gate; }
              try { await route.fulfill({ contentType: "text/plain", body: label }); }
              catch (error) { if (!first) throw error; }
            });
            await page.goto(`https://app.example/app/components/${kind === "live" ? "cycle.html" : "svelte"}`);
          }
          await pages[0]!.addScriptTag({ path: liveBundle });
          await pages[0]!.evaluate(() => (window.HtmlRuntime as typeof window.HtmlRuntime & { observeDocument(): () => void }).observeDocument());
          await pages[1]!.addScriptTag({ path: output.bundle });
          await Promise.all([...started.values()].map(entry => entry.promise));
          const act = (name: string) => Promise.all(pages.map(page => page.evaluate((selector) =>
            document.querySelector<HTMLButtonElement>(selector)!.click(), `button.${name}`)));
          const waitFor = (label: string) => Promise.all(pages.map(page => page.waitForFunction(expected =>
            document.querySelector("#case .label")?.textContent === expected && document.querySelector("#case .pending")?.textContent === "false", label, { timeout: 5000 })));
          const firstLabel = "/app/components/api/read?query=1&sample=2024-02-29";
          assert.deepEqual(requests.live, [firstLabel], "native initial parameter sample");
          assert.deepEqual(requests.svelte, requests.live);
          await act("invalid");
          await new Promise(resolve => setTimeout(resolve, 150));
          assert.deepEqual(requests.live, [firstLabel], "invalid reactive reads preserve the native in-flight request");
          assert.deepEqual(requests.svelte, requests.live, "invalid reactive reads must not restart a request");
          assert.deepEqual(failed.svelte, failed.live, "invalid reactive reads must not abort a request");
          release();
          await waitFor(firstLabel);
          await act("partial");
          await waitFor("/app/components/api/read?query=2&sample=2024-02-29");
          await act("sample");
          await waitFor("/app/components/api/read?query=2&sample=2025-01-01");
          assert.ok(requests.svelte.every(url => !url.includes("bad") && !url.includes("sample=42")));
          await Promise.all(pages.map(page => page.evaluate(() => {
            const root = document.querySelector("#case")!;
            (window as unknown as { detachedDataRoot: Element }).detachedDataRoot = root; root.remove();
          })));
          await new Promise(resolve => setTimeout(resolve, 150));
          const detached = { live: requests.live.length, svelte: requests.svelte.length };
          await new Promise(resolve => setTimeout(resolve, 750));
          assert.deepEqual({ live: requests.live.length, svelte: requests.svelte.length }, detached, "detached resources stop polling");
          await Promise.all(pages.map(page => page.evaluate(() => document.querySelector("main")!.append(
            (window as unknown as { detachedDataRoot: Element }).detachedDataRoot))));
          await new Promise(resolve => setTimeout(resolve, 750));
          assert.deepEqual({ live: requests.live.length, svelte: requests.svelte.length }, detached, "invalid reconnect cannot restart polling");
          await act("recover");
          await waitFor("/app/components/api/read?query=3&sample=2026-01-01");
          assert.deepEqual(errors, []);
        } finally {
          release();
          try { await Promise.all(pages.map(page => page.close())); }
          finally { await browser.close(); }
        }
      });

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
          for (const page of pages) {
            await page.clock.install({ time: new Date("2030-01-01T00:00:00Z") });
            await page.clock.pauseAt(new Date("2030-01-01T00:00:01Z"));
          }
          await pages[0]!.addScriptTag({ path: liveBundle });
          await pages[0]!.evaluate(() => window.HtmlRuntime.lowerDocument());
          await pages[1]!.addScriptTag({ path: output.bundle });
          await Promise.all(pages.map((page) => page.evaluate(() => document.querySelector<HTMLButtonElement>("button.sample")!.click())));
          const waitFor = async (label: string): Promise<void> => {
            // Network responses and framework microtasks remain real while browser timers are paused.
            for (let attempt = 0; attempt < 250; attempt += 1) {
              const labels = await Promise.all(pages.map(page => page.locator("#case .label").textContent()));
              if (labels.every(value => value === label)) return;
              await new Promise(resolve => setTimeout(resolve, 20));
            }
            assert.deepEqual(await Promise.all(pages.map(page => page.locator("#case .label").textContent())), pages.map(() => label));
          };
          await Promise.all(pages.map(page => page.clock.runFor(80)));
          await waitFor("/app/components/api/After?page=2&tag=a&tag=b");
          assert.deepEqual(requests.svelte, requests.live);
          await Promise.all(pages.map((page) => page.locator("button.sample").click()));
          const counts = { live: requests.live.length, svelte: requests.svelte.length };
          await Promise.all(pages.map(page => page.clock.runFor(120)));
          assert.deepEqual({ live: requests.live.length, svelte: requests.svelte.length }, counts, "sample-only writes do not trigger reads");
          await Promise.all(pages.map(page => page.clock.runFor(500)));
          await waitFor("/app/components/api/Before?page=2&tag=a&tag=b");
          await Promise.all(pages.map((page) => page.evaluate(() => {
            const button = document.querySelector<HTMLButtonElement>("button.next")!; button.click(); button.click();
          })));
          await Promise.all(pages.map(page => page.clock.runFor(80)));
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
      let reinserting = false;
      const restarted = new Set<string>();
      let reportRestart!: () => void;
      const bothRestarted = new Promise<void>((resolve) => { reportRestart = resolve; });
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
            if (reinserting) { restarted.add(kind); if (restarted.size === 2) reportRestart(); }
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
        await Promise.all([live, svelte].map((page) => page.evaluate(() => {
          const globals = window as unknown as { detachedResource: Element };
          globals.detachedResource = document.querySelector("#case")!;
          globals.detachedResource.remove();
        })));
        await Promise.all([live, svelte].map((page) => page.waitForTimeout(50)));
        const pausedCount = { live: requests.live.length, svelte: requests.svelte.length };
        await new Promise((resolve) => setTimeout(resolve, 1700));
        assert.deepEqual({ live: requests.live.length, svelte: requests.svelte.length }, pausedCount, "external disconnection must stop polling");
        reinserting = true;
        await Promise.all([live, svelte].map((page) => page.evaluate(() =>
          document.querySelector("main")!.append((window as unknown as { detachedResource: Element }).detachedResource))));
        await bothRestarted;
        await waitFor("Fourth");
        await Promise.all([live, svelte].map((page) => page.waitForFunction(() =>
          document.querySelector("#case .pending")?.textContent === "false")));
        assert.deepEqual((await snapshot(svelte)).behavior, (await snapshot(live)).behavior);
        const moveCount = { live: requests.live.length, svelte: requests.svelte.length };
        await Promise.all([live, svelte].map((page) => page.evaluate(() => {
          const main = document.querySelector("main")!;
          main.append(document.createElement("span")); main.append(document.querySelector("#case")!);
        })));
        await Promise.all([live, svelte].map((page) => page.waitForTimeout(100)));
        assert.deepEqual({ live: requests.live.length, svelte: requests.svelte.length }, moveCount, "in-tree moves must retain the request lifetime");
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
