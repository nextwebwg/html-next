import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";

import { compileScript, compileTemplate, parse as parseVue } from "@vue/compiler-sfc";
import { build } from "esbuild";
import { chromium, firefox, webkit, type Browser, type BrowserType, type Page } from "playwright";

import { convertComponents } from "../src/index.js";

import { assertPixelsEqual } from "../../html-next/tests/pixel-parity.js";

const enabled = process.env.HTMLNEXT_TARGET_TEST === "1";
const nodeModulesPath = new URL("../../html-next/node_modules", import.meta.url).pathname;
const livePath = new URL("../../html-next/src/live.ts", import.meta.url).pathname;
const source = `<template component="x-feed" status="early" summary="Feed."><defs>
  <data name="nearby" src="./api/feed" type="object({ label: string })"></data>
  <data name="rooted" src="/api/root" type="object({ label: string })"></data>
  <data name="note" src="./api/note" type="string"><param name="tag" :value="['a', 'b']"></param></data>
</defs><section><output class="nearby" $value="nearby.value.label"></output>
<output class="rooted" $value="rooted.value.label"></output><output class="note" $value="note.value"></output></section></template>`;
const lifecycleSource = `<template component="x-data-cycle" status="early" summary="Data lifecycle."><defs>
  <state name="page" :value="1"></state>
  <data name="feed" src="/api/cycle" type="object({ label: string })" debounce="500ms" poll="1500ms"><param name="page" :value="page"></param></data>
  <handler name="next"><set name="page" :value="page + 1"></set></handler>
</defs><section><button type="button" on:click="next">Next</button>
<output class="label" $value="feed.value.label"></output>
<output class="pending" $value="feed.pending"></output>
<output class="ok" $value="feed.ok"></output>
<output class="failed" $value="feed.error ? 'yes' : 'no'"></output></section></template>`;

async function snapshot(page: Page): Promise<{ text: string; pixels: Buffer }> {
  await page.waitForFunction(() => document.querySelector("#case")?.textContent?.replace(/\s/g, "") === "NearRootNote", undefined, { timeout: 5000 });
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  return {
    text: await page.locator("#case").textContent() ?? "",
    pixels: await page.locator("#case").screenshot({ animations: "disabled" }),
  };
}

describe.skipIf(!enabled)("public Vue converter data URL parity", () => {
  let directory = "";
  let liveBundle = "";
  let vueBundle = "";
  let lifecycleVueBundle = "";
  const hydrationOutputs = new Map<"application" | "library", { readonly bundle: string; readonly markup: string }>();
  const lifecycleHydrationOutputs = new Map<"application" | "library", { readonly bundle: string; readonly markup: string }>();

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-vue-converter-parity-"));
    await mkdir(join(directory, "components"));
    await writeFile(join(directory, "components", "feed.html"), source);
    liveBundle = join(directory, "live.js");
    await build({ entryPoints: [livePath], outfile: liveBundle, bundle: true, format: "iife", globalName: "HtmlRuntime", platform: "browser", target: ["es2022"] });

    const outDirectory = join(directory, "generated");
    await convertComponents({ mode: "application", target: "vue", entries: ["components/feed.html"], root: directory, outDirectory, publicRootURL: "/app/" });
    const component = join(outDirectory, "vue", "XFeed.vue");
    const parsed = parseVue(await readFile(component, "utf8"), { filename: component });
    assert.deepEqual(parsed.errors, []);
    const script = compileScript(parsed.descriptor, { id: "data-parity", inlineTemplate: true });
    await writeFile(component.replace(/\.vue$/, ".ts"), script.content);
    const entry = join(outDirectory, "entry.ts");
    vueBundle = join(outDirectory, "vue.js");
    await writeFile(entry, `import { createApp, h } from "vue";
import XFeed from "./vue/XFeed";
createApp({ render: () => h(XFeed, { id: "case" }) }).mount(document.querySelector("main"));\n`);
    await build({ entryPoints: [entry], outfile: vueBundle, bundle: true, format: "iife", platform: "browser", target: ["es2022"], nodePaths: [nodeModulesPath] });

    for (const mode of ["application", "library"] as const) {
      const hydrationDirectory = mode === "application" ? outDirectory : join(directory, "generated-library");
      if (mode === "library") {
        await convertComponents({ mode, target: "vue", entries: ["components/feed.html"], root: directory, outDirectory: hydrationDirectory, publicRootURL: "/app/" });
      }
      const file = join(hydrationDirectory, "vue", "XFeed.vue");
      const descriptor = parseVue(await readFile(file, "utf8"), { filename: file }).descriptor;
      if (mode === "library") {
        await writeFile(file.replace(/\.vue$/, ".ts"), compileScript(descriptor, { id: `data-hydration-${mode}`, inlineTemplate: true }).content);
      }
      const serverScript = compileScript(descriptor, { id: `data-hydration-${mode}` });
      const serverTemplate = compileTemplate({
        source: descriptor.template!.content,
        filename: file,
        id: `data-hydration-${mode}`,
        ssr: true,
        ssrCssVars: [],
        compilerOptions: { bindingMetadata: serverScript.bindings ?? {} },
      });
      assert.deepEqual(serverTemplate.errors, []);
      await writeFile(file.replace(/\.vue$/, ".ssr.ts"), `${serverScript.content.replace("export default", "const Component =")}
${serverTemplate.code}
export default Object.assign(Component, { ssrRender });
`);
      const hydrateEntry = join(hydrationDirectory, "hydrate.ts");
      const hydrateBundle = join(hydrationDirectory, "hydrate.js");
      await writeFile(hydrateEntry, `import { createSSRApp, h } from "vue";
import { XFeed } from "./vue/${mode === "application" ? "application" : "index"}";
createSSRApp({ render: () => h(XFeed, { id: "case" }) }).mount(document.querySelector("main"));\n`);
      await build({
        entryPoints: [hydrateEntry], outfile: hydrateBundle, bundle: true, format: "iife", platform: "browser", target: ["es2022"], nodePaths: [nodeModulesPath],
        plugins: [{ name: "compiled-vue-sfc", setup(pluginBuild) {
          pluginBuild.onResolve({ filter: /\.vue$/ }, (args) => ({ path: resolve(args.resolveDir, args.path.replace(/\.vue$/, ".ts")) }));
        } }],
      });
      const serverEntry = join(hydrationDirectory, "server.ts");
      await writeFile(serverEntry, `import { createSSRApp, h } from "vue";
import { renderToString } from "@vue/server-renderer";
import { XFeed } from "./vue/${mode === "application" ? "application" : "index"}";
export const render = () => renderToString(createSSRApp({ render: () => h(XFeed, { id: "case" }) }));\n`);
      const serverBuild = await build({
        entryPoints: [serverEntry], bundle: true, format: "esm", platform: "node", write: false, nodePaths: [nodeModulesPath],
        plugins: [{ name: "compiled-vue-sfc-ssr", setup(pluginBuild) {
          pluginBuild.onResolve({ filter: /\.vue$/ }, (args) => ({ path: resolve(args.resolveDir, args.path.replace(/\.vue$/, ".ssr.ts")) }));
        } }],
      });
      const serverModule = await import(`data:text/javascript;base64,${Buffer.from(serverBuild.outputFiles[0]!.text).toString("base64")}`);
      const markup = await serverModule.render() as string;
      assert.match(markup, /<section[^>]*id="case"/);
      hydrationOutputs.set(mode, { bundle: hydrateBundle, markup });
    }

    await writeFile(join(directory, "components", "cycle.html"), lifecycleSource);
    const lifecycleOutput = join(directory, "generated-lifecycle");
    await convertComponents({ mode: "application", target: "vue", entries: ["components/cycle.html"], root: directory, outDirectory: lifecycleOutput, publicRootURL: "/app/" });
    const lifecycleComponent = join(lifecycleOutput, "vue", "XDataCycle.vue");
    const lifecycleParsed = parseVue(await readFile(lifecycleComponent, "utf8"), { filename: lifecycleComponent });
    assert.deepEqual(lifecycleParsed.errors, []);
    await writeFile(lifecycleComponent.replace(/\.vue$/, ".ts"), compileScript(lifecycleParsed.descriptor, { id: "data-lifecycle-parity", inlineTemplate: true }).content);
    const lifecycleEntry = join(lifecycleOutput, "entry.ts");
    lifecycleVueBundle = join(lifecycleOutput, "vue.js");
    await writeFile(lifecycleEntry, `import { createApp, h } from "vue";
import XDataCycle from "./vue/XDataCycle";
window.vueApp = createApp({ render: () => h(XDataCycle, { id: "case" }) });
window.vueApp.mount(document.querySelector("main"));\n`);
    await build({ entryPoints: [lifecycleEntry], outfile: lifecycleVueBundle, bundle: true, format: "iife", platform: "browser", target: ["es2022"], nodePaths: [nodeModulesPath] });

    for (const mode of ["application", "library"] as const) {
      const output = mode === "application" ? lifecycleOutput : join(directory, "generated-lifecycle-library");
      if (mode === "library") {
        await convertComponents({ mode, target: "vue", entries: ["components/cycle.html"], root: directory, outDirectory: output, publicRootURL: "/app/" });
      }
      const file = join(output, "vue", "XDataCycle.vue");
      const descriptor = parseVue(await readFile(file, "utf8"), { filename: file }).descriptor;
      if (mode === "library") {
        await writeFile(file.replace(/\.vue$/, ".ts"), compileScript(descriptor, { id: `data-cycle-hydration-${mode}`, inlineTemplate: true }).content);
      }
      const serverScript = compileScript(descriptor, { id: `data-cycle-hydration-${mode}` });
      const serverTemplate = compileTemplate({
        source: descriptor.template!.content,
        filename: file,
        id: `data-cycle-hydration-${mode}`,
        ssr: true,
        ssrCssVars: [],
        compilerOptions: { bindingMetadata: serverScript.bindings ?? {} },
      });
      assert.deepEqual(serverTemplate.errors, []);
      await writeFile(file.replace(/\.vue$/, ".ssr.ts"), `${serverScript.content.replace("export default", "const Component =")}
${serverTemplate.code}
export default Object.assign(Component, { ssrRender });
`);
      const hydrateEntry = join(output, "hydrate.ts");
      const hydrateBundle = join(output, "hydrate.js");
      await writeFile(hydrateEntry, `import { createSSRApp, h } from "vue";
import { XDataCycle } from "./vue/${mode === "application" ? "application" : "index"}";
window.vueApp = createSSRApp({ render: () => h(XDataCycle, { id: "case" }) });
window.vueApp.mount(document.querySelector("main"));\n`);
      await build({
        entryPoints: [hydrateEntry], outfile: hydrateBundle, bundle: true, format: "iife", platform: "browser", target: ["es2022"], nodePaths: [nodeModulesPath],
        plugins: [{ name: "compiled-vue-sfc", setup(pluginBuild) {
          pluginBuild.onResolve({ filter: /\.vue$/ }, (args) => ({ path: resolve(args.resolveDir, args.path.replace(/\.vue$/, ".ts")) }));
        } }],
      });
      const serverEntry = join(output, "server.ts");
      await writeFile(serverEntry, `import { createSSRApp, h } from "vue";
import { renderToString } from "@vue/server-renderer";
import { XDataCycle } from "./vue/${mode === "application" ? "application" : "index"}";
export const render = () => renderToString(createSSRApp({ render: () => h(XDataCycle, { id: "case" }) }));\n`);
      const serverBuild = await build({
        entryPoints: [serverEntry], bundle: true, format: "esm", platform: "node", write: false, nodePaths: [nodeModulesPath],
        plugins: [{ name: "compiled-vue-sfc-ssr", setup(pluginBuild) {
          pluginBuild.onResolve({ filter: /\.vue$/ }, (args) => ({ path: resolve(args.resolveDir, args.path.replace(/\.vue$/, ".ssr.ts")) }));
        } }],
      });
      const serverModule = await import(`data:text/javascript;base64,${Buffer.from(serverBuild.outputFiles[0]!.text).toString("base64")}`);
      const markup = await serverModule.render() as string;
      assert.match(markup, /<section[^>]*id="case"/);
      lifecycleHydrationOutputs.set(mode, { bundle: hydrateBundle, markup });
    }
  });

  afterAll(async () => { if (directory !== "") await rm(directory, { recursive: true, force: true }); });

  for (const [engine, browserType] of [["Chromium", chromium], ["Firefox", firefox], ["WebKit", webkit]] as const satisfies ReadonlyArray<readonly [string, BrowserType]>) {
    for (const mode of ["application", "library"] as const) {
      it(`${engine} ${mode} begins declared reads on hydration, not SSR`, async () => {
        const browser = await browserType.launch({ headless: true });
        const [live, hydrated] = await Promise.all([browser.newPage(), browser.newPage()]);
        const requested = { live: [] as string[], hydrated: [] as string[] };
        const errors: string[] = [];
        const warnings: string[] = [];
        try {
          for (const [page, record] of [[live, requested.live], [hydrated, requested.hydrated]] as const) {
            page.on("pageerror", (error) => errors.push(error.message));
            await page.route("https://app.example/**", async (route) => {
              if (route.request().resourceType() === "document") {
                await route.fulfill({ contentType: "text/html", body: page === live
                  ? `${source}<main><x-feed id="case"></x-feed></main>`
                  : `<main>${hydrationOutputs.get(mode)!.markup}</main>` });
                return;
              }
              const url = route.request().url();
              record.push(url);
              if (url.includes("/api/note")) {
                await route.fulfill({ contentType: "text/plain", body: "Note" });
                return;
              }
              const label = url.endsWith("/api/feed") ? "Near" : "Root";
              await route.fulfill({ contentType: "application/json", body: JSON.stringify({ label }) });
            });
          }
          hydrated.on("console", (message) => { if (message.type() === "warning") warnings.push(message.text()); });
          await Promise.all([live.goto("https://app.example/app/components/feed.html"), hydrated.goto("https://app.example/app/page")]);
          assert.equal(await hydrated.locator("#case").count(), 1, "server output must contain the native component root");
          assert.deepEqual(requested.hydrated, [], "server rendering must not start browser requests");
          await live.addScriptTag({ path: liveBundle });
          await live.evaluate(() => window.HtmlRuntime.lowerDocument());
          await hydrated.addScriptTag({ path: hydrationOutputs.get(mode)!.bundle });
          const [liveState, hydratedState] = await Promise.all([snapshot(live), snapshot(hydrated)]);
          assert.equal(hydratedState.text.replace(/\s/g, ""), liveState.text.replace(/\s/g, ""));
          await assertPixelsEqual(hydrated, hydratedState.pixels, liveState.pixels, "hydrated data pixels differ");
          const expected = ["https://app.example/api/root", "https://app.example/app/components/api/feed", "https://app.example/app/components/api/note?tag=a&tag=b"];
          assert.deepEqual(requested.live.sort(), expected);
          assert.deepEqual(requested.hydrated.sort(), expected);
          assert.deepEqual(warnings.filter((message) => !message.startsWith("Feature flags ") && /hydration|mismatch/i.test(message)), [], "Vue reported a hydration mismatch");
          assert.deepEqual(errors, []);
        } finally {
          await Promise.all([live.close(), hydrated.close()]);
          await browser.close();
        }
      });

      it(`${engine} ${mode} keeps failures, polling, cancellation, and disposal after hydration`, async () => {
        const browser = await browserType.launch({ headless: true });
        const [live, hydrated] = await Promise.all([browser.newPage(), browser.newPage()]);
        const pages = [live, hydrated];
        const requested = { live: [] as string[], hydrated: [] as string[] };
        const canceled = { live: 0, hydrated: 0 };
        const errors: string[] = [];
        const warnings: string[] = [];
        let releaseStale!: () => void;
        const staleHeld = new Promise<void>((done) => { releaseStale = done; });
        let bothStale!: () => void;
        const bothStaleRequests = new Promise<void>((done) => { bothStale = done; });
        let allStaleDone!: () => void;
        const staleDone = new Promise<void>((done) => { allStaleDone = done; });
        let staleCount = 0;
        let staleFinished = 0;
        try {
          for (const [page, kind] of [[live, "live"], [hydrated, "hydrated"]] as const) {
            page.on("pageerror", (error) => errors.push(error.message));
            page.on("requestfailed", (request) => { if (request.url().includes("/api/cycle?page=3")) canceled[kind] += 1; });
            await page.route("https://app.example/**", async (route) => {
              if (route.request().resourceType() === "document") {
                await route.fulfill({ contentType: "text/html", body: page === live
                  ? `${lifecycleSource}<main><x-data-cycle id="case"></x-data-cycle></main>`
                  : `<main>${lifecycleHydrationOutputs.get(mode)!.markup}</main>` });
                return;
              }
              const url = new URL(route.request().url());
              const pageNumber = url.searchParams.get("page");
              requested[kind].push(`${url.pathname}${url.search}`);
              if (pageNumber === "3") {
                staleCount += 1;
                if (staleCount === 2) bothStale();
                await staleHeld;
                try { await route.fulfill({ contentType: "application/json", body: JSON.stringify({ label: "STALE" }) }); }
                catch { /* A newer request aborted this one. */ }
                staleFinished += 1;
                if (staleFinished === 2) allStaleDone();
                return;
              }
              const failed = pageNumber === "2" && requested[kind].filter((entry) => entry === "/api/cycle?page=2").length === 1;
              const label = pageNumber === "1" ? "First" : pageNumber === "2" ? "Recovered" : "Fourth";
              await route.fulfill({ status: failed ? 503 : 200, contentType: "application/json", body: failed ? "unavailable" : JSON.stringify({ label }) });
            });
          }
          hydrated.on("console", (message) => { if (message.type() === "warning") warnings.push(message.text()); });
          await Promise.all([live.goto("https://app.example/app/live"), hydrated.goto("https://app.example/app/hydrated")]);
          assert.deepEqual(requested.hydrated, [], "SSR must not start polling or fetch a declared source");
          await live.addScriptTag({ path: liveBundle });
          await live.evaluate(() => (window.HtmlRuntime as typeof window.HtmlRuntime & { observeDocument(): () => void }).observeDocument());
          await hydrated.addScriptTag({ path: lifecycleHydrationOutputs.get(mode)!.bundle });
          const waitFor = async (label: string, failed: string) => {
            await Promise.all(pages.map((page) => page.waitForFunction(([expectedLabel, expectedFailure]) => {
              const root = document.querySelector("#case");
              return root?.querySelector(".label")?.textContent === expectedLabel && root?.querySelector(".failed")?.textContent === expectedFailure;
            }, [label, failed], { timeout: 5000 })));
          };
          const compare = async (stage: string) => {
            await Promise.all(pages.map((page) => page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))))));
            const read = async (page: Page) => ({
              behavior: await page.locator("#case").evaluate((root) => Object.fromEntries(["label", "pending", "ok", "failed"].map((name) => [name, root.querySelector(`.${name}`)?.textContent]))),
              pixels: await page.locator("#case").screenshot({ animations: "disabled" }),
            });
            const [actualLive, actualHydrated] = await Promise.all([read(live), read(hydrated)]);
            assert.deepEqual(actualHydrated.behavior, actualLive.behavior, `${stage} hydrated data behavior differs`);
            await assertPixelsEqual(hydrated, actualHydrated.pixels, actualLive.pixels, `${stage} hydrated data pixels differ`);
          };
          await waitFor("First", "no");
          await compare("loaded");
          await Promise.all(pages.map((page) => page.locator("#case button").click()));
          await waitFor("First", "yes");
          await compare("failed");
          await waitFor("Recovered", "no");
          await compare("polled");
          await Promise.all(pages.map((page) => page.locator("#case button").click()));
          await bothStaleRequests;
          await Promise.all(pages.map((page) => page.locator("#case button").click()));
          await waitFor("Fourth", "no");
          releaseStale();
          await staleDone;
          await compare("canceled");
          assert.deepEqual(canceled, { live: 1, hydrated: 1 });
          const counts = { live: requested.live.length, hydrated: requested.hydrated.length };
          await Promise.all([live.evaluate(() => document.querySelector("#case")?.remove()), hydrated.evaluate(() => window.vueApp.unmount())]);
          await new Promise((done) => setTimeout(done, 1700));
          assert.deepEqual({ live: requested.live.length, hydrated: requested.hydrated.length }, counts, "disposed hydrated reads must stop polling");
          assert.deepEqual(warnings.filter((message) => !message.startsWith("Feature flags ") && /hydration|mismatch/i.test(message)), [], "Vue reported a hydration mismatch");
          assert.deepEqual(errors, []);
        } finally {
          releaseStale();
          await Promise.all(pages.map((page) => page.close()));
          await browser.close();
        }
      });
    }

    it(`${engine} matches polling, failed reads, stale retention, cancellation, and disposal`, async () => {
      const browser = await browserType.launch({ headless: true });
      const [live, vue] = await Promise.all([browser.newPage(), browser.newPage()]);
      const requests = { live: [] as string[], vue: [] as string[] };
      const canceled = { live: 0, vue: 0 };
      const errors: string[] = [];
      let releaseStale!: () => void;
      const staleHeld = new Promise<void>((resolve) => { releaseStale = resolve; });
      let bothStale!: () => void;
      const bothStaleRequests = new Promise<void>((resolve) => { bothStale = resolve; });
      let allStaleDone!: () => void;
      const staleDone = new Promise<void>((resolve) => { allStaleDone = resolve; });
      let staleCount = 0;
      let staleFinished = 0;
      try {
        for (const [page, record, kind] of [[live, requests.live, "live"], [vue, requests.vue, "vue"]] as const) {
          page.on("pageerror", (error) => errors.push(error.message));
          page.on("requestfailed", (request) => { if (request.url().includes("/api/cycle?page=3")) canceled[kind] += 1; });
          await page.route("https://app.example/**", async (route) => {
            if (route.request().resourceType() === "document") {
              await route.fulfill({ contentType: "text/html", body: page === live ? `${lifecycleSource}<main><x-data-cycle id="case"></x-data-cycle></main>` : "<main></main>" });
              return;
            }
            const url = new URL(route.request().url());
            const pageNumber = url.searchParams.get("page");
            record.push(`${url.pathname}${url.search}`);
            if (pageNumber === "3") {
              staleCount += 1;
              if (staleCount === 2) bothStale();
              await staleHeld;
              try { await route.fulfill({ contentType: "application/json", body: JSON.stringify({ label: "STALE" }) }); }
              catch { /* An aborted request cannot be fulfilled. */ }
              staleFinished += 1;
              if (staleFinished === 2) allStaleDone();
              return;
            }
            const failed = pageNumber === "2" && record.filter((entry) => entry === "/api/cycle?page=2").length === 1;
            const label = pageNumber === "1" ? "First" : pageNumber === "2" ? "Recovered" : pageNumber === "4" ? "Fourth" : pageNumber === "6" ? "Sixth" : "Fifth";
            await route.fulfill({ status: failed ? 503 : 200, contentType: "application/json", body: failed ? "unavailable" : JSON.stringify({ label }) });
          });
        }
        await Promise.all([live.goto("https://app.example/app/live"), vue.goto("https://app.example/app/vue")]);
        await live.addScriptTag({ path: liveBundle });
        await live.evaluate(() => (window.HtmlRuntime as typeof window.HtmlRuntime & { observeDocument(): () => void }).observeDocument());
        await vue.addScriptTag({ path: lifecycleVueBundle });
        const waitFor = async (label: string, failed: string) => {
          try {
            await Promise.all([live, vue].map((page) => page.waitForFunction(([expectedLabel, expectedFailure]) => {
              const root = document.querySelector("#case");
              return root?.querySelector(".label")?.textContent === expectedLabel && root?.querySelector(".failed")?.textContent === expectedFailure;
            }, [label, failed], { timeout: 5000 })));
          } catch (error) {
            const [liveMarkup, vueMarkup] = await Promise.all([live, vue].map((page) => page.locator("#case").evaluate((root) => root.outerHTML)));
            throw new Error(`${String(error)}; expected=${label}/${failed}; live=${liveMarkup}; vue=${vueMarkup}; requests=${JSON.stringify(requests)}; errors=${JSON.stringify(errors)}`, { cause: error });
          }
        };
        const compare = async (stage: string) => {
          await Promise.all([live, vue].map((page) => page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))));
          const read = async (page: Page) => ({
            behavior: await page.locator("#case").evaluate((root) => Object.fromEntries(["label", "pending", "ok", "failed"].map((name) => [name, root.querySelector(`.${name}`)?.textContent]))),
            pixels: await page.locator("#case").screenshot({ animations: "disabled" }),
          });
          const [actualLive, actualVue] = await Promise.all([read(live), read(vue)]);
          assert.deepEqual(actualVue.behavior, actualLive.behavior, `${stage} data behavior differs`);
          await assertPixelsEqual(vue, actualVue.pixels, actualLive.pixels, `${stage} pixels differ`);
          return actualLive.behavior;
        };
        await waitFor("First", "no");
        assert.deepEqual(await compare("loaded"), { label: "First", pending: "false", ok: "true", failed: "no" });

        await Promise.all([live, vue].map((page) => page.locator("#case button").click()));
        await waitFor("First", "yes");
        assert.deepEqual(await compare("failed"), { label: "First", pending: "false", ok: "false", failed: "yes" });
        await waitFor("Recovered", "no");
        assert.deepEqual(await compare("polled"), { label: "Recovered", pending: "false", ok: "true", failed: "no" });

        await Promise.all([live, vue].map((page) => page.locator("#case button").click()));
        await bothStaleRequests;
        await Promise.all([live, vue].map((page) => page.locator("#case button").click()));
        await waitFor("Fourth", "no");
        releaseStale();
        await staleDone;
        assert.deepEqual(await compare("canceled"), { label: "Fourth", pending: "false", ok: "true", failed: "no" });
        assert.deepEqual(canceled, { live: 1, vue: 1 }, "a newer data key must abort each stale GET");

        await Promise.all([live, vue].map((page) => page.evaluate(() => (document.querySelector("#case button") as HTMLButtonElement).click())));
        await new Promise((resolve) => setTimeout(resolve, 100));
        await Promise.all([live, vue].map((page) => page.evaluate(() => (document.querySelector("#case button") as HTMLButtonElement).click())));
        await waitFor("Sixth", "no");
        assert.deepEqual(await compare("debounced"), { label: "Sixth", pending: "false", ok: "true", failed: "no" });
        for (const record of [requests.live, requests.vue]) {
          assert.equal(record.filter((url) => url === "/api/cycle?page=5").length, 0, "debounce should suppress the intermediate key");
          assert.equal(record.filter((url) => url === "/api/cycle?page=6").length, 1, "debounce should fetch the final key once");
        }
        const counts = { live: requests.live.length, vue: requests.vue.length };
        await Promise.all([live.evaluate(() => document.querySelector("#case")?.remove()), vue.evaluate(() => window.vueApp.unmount())]);
        await new Promise((resolve) => setTimeout(resolve, 1700));
        assert.deepEqual({ live: requests.live.length, vue: requests.vue.length }, counts, "disposed components must stop polling");
        assert.deepEqual(errors, []);
      } finally {
        releaseStale();
        await Promise.all([live.close(), vue.close()]);
        await browser.close();
      }
    });

    it(`${engine} preserves component-relative and root-relative requests`, async () => {
      const browser: Browser = await browserType.launch({ headless: true });
      const [live, vue] = await Promise.all([browser.newPage(), browser.newPage()]);
      const requested = { live: [] as string[], vue: [] as string[] };
      const errors: string[] = [];
      try {
        for (const [page, record] of [[live, requested.live], [vue, requested.vue]] as const) {
          page.on("pageerror", (error) => errors.push(error.message));
          await page.route("https://app.example/**", async (route) => {
            if (route.request().resourceType() === "document") {
              await route.fulfill({ contentType: "text/html", body: page === live ? `${source}<main><x-feed id="case"></x-feed></main>` : "<main></main>" });
              return;
            }
            record.push(route.request().url());
            if (route.request().url().includes("/api/note")) {
              await route.fulfill({ contentType: "text/plain", headers: { "access-control-allow-origin": "*" }, body: "Note" });
              return;
            }
            const label = route.request().url().endsWith("/api/feed") ? "Near" : "Root";
            await route.fulfill({ contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({ label }) });
          });
        }
        await live.goto("https://app.example/app/components/feed.html");
        await live.addScriptTag({ path: liveBundle });
        await live.evaluate(() => window.HtmlRuntime.lowerDocument());
        await vue.goto("https://app.example/app/page");
        await vue.addScriptTag({ path: vueBundle });

        const [liveState, vueState] = await Promise.all([snapshot(live), snapshot(vue)]).catch(async (error: unknown) => {
          const liveText = await live.locator("#case").textContent();
          const vueText = await vue.locator("#case").textContent();
          const liveMarkup = await live.locator("#case").evaluate((node) => node.outerHTML);
          const hasDefinition = await live.locator("template[component]").count();
          throw new Error(`${String(error)}; live=${JSON.stringify(liveText)}; vue=${JSON.stringify(vueText)}; liveMarkup=${JSON.stringify(liveMarkup)}; definition=${hasDefinition}; requests=${JSON.stringify(requested)}; errors=${JSON.stringify(errors)}`);
        });
        assert.equal(vueState.text.replace(/\s/g, ""), liveState.text.replace(/\s/g, ""));
        await assertPixelsEqual(vue, vueState.pixels, liveState.pixels, "data pixels differ");
        const expected = ["https://app.example/api/root", "https://app.example/app/components/api/feed", "https://app.example/app/components/api/note?tag=a&tag=b"];
        assert.deepEqual(requested.live.sort(), expected);
        assert.deepEqual(requested.vue.sort(), expected);
        assert.deepEqual(errors, []);
      } finally {
        await Promise.all([live.close(), vue.close()]);
        await browser.close();
      }
    });
  }
});

declare global {
  interface Window {
    HtmlRuntime: { lowerDocument(): void };
    vueApp: { unmount(): void };
  }
}
