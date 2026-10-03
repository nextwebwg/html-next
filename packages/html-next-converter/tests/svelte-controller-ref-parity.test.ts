import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, it } from "vitest";
import { build } from "esbuild";
import { chromium, firefox, webkit, type BrowserType, type Page } from "playwright";

import { convertComponents } from "../src/index.js";
import { sveltePlugin } from "./helpers/svelte.js";
import { assertPixelsEqual, launchParityBrowser } from "../../html-next/tests/pixel-parity.js";
import { controllerRefsSource as source, controllerRefsModule as controller } from "./fixtures/controller-refs.js";

async function snapshot(page: Page) {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  return {
    behavior: await page.evaluate(() => {
      const globals = window as unknown as { refsEffects: number; refsHost: {
        refs: Record<string, Element | readonly Element[] | undefined>;
      } };
      const refs = globals.refsHost.refs;
      const read = (name: string) => {
        const value = refs[name];
        return value === undefined ? null : Array.isArray(value)
          ? { array: value.map((element: Element) => element.textContent) }
          : { single: (value as Element).textContent, connected: (value as Element).isConnected };
      };
      return { row: read("row"), later: read("later"), single: read("single"),
        hasRow: "row" in refs, hasLater: "later" in refs, hasSingle: "single" in refs, effects: globals.refsEffects };
    }),
    pixels: await page.locator("#case").screenshot({ animations: "disabled" }),
  };
}

describe.skipIf(process.env.HTMLNEXT_TARGET_TEST !== "1")("Svelte controller ref parity", () => {
  let directory = "";
  let liveBundle = "";
  const outputs = new Map<"application" | "library", { bundle: string; markup: string; css: string }>();
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-svelte-refs-"));
    await symlink(fileURLToPath(new URL("../node_modules", import.meta.url)), join(directory, "node_modules"), "dir");
    await writeFile(join(directory, "refs.html"), source);
    await writeFile(join(directory, "refs.js"), controller);
    liveBundle = join(directory, "live.js");
    await build({ entryPoints: [fileURLToPath(new URL("../../html-next/src/browser-loader.ts", import.meta.url))],
      outfile: liveBundle, bundle: true, format: "iife", globalName: "HtmlNextLoader", platform: "browser", target: ["es2022"] });
    for (const mode of ["application", "library"] as const) {
      const outDirectory = join(directory, mode);
      const manifest = await convertComponents({ mode, target: "svelte", root: directory, outDirectory, entries: ["refs.html"] });
      const css = (await Promise.all(manifest.output.artifacts.filter((artifact) => artifact.kind === "style")
        .map((artifact) => readFile(join(outDirectory, artifact.path), "utf8")))).join("\n");
      await writeFile(join(outDirectory, "App.svelte"), `<script>import XRefs from "./${manifest.components[0]!.artifact}";</script><XRefs id="case" />`);
      const entry = join(outDirectory, "mount.ts");
      await writeFile(entry, `import { mount, hydrate } from "svelte"; import App from "./App.svelte";
const target = document.querySelector("main")!;
if (target.hasChildNodes()) hydrate(App, { target }); else mount(App, { target });`);
      const bundle = join(outDirectory, "mount.js");
      await build({ entryPoints: [entry], outfile: bundle, bundle: true, format: "iife", platform: "browser",
        target: ["es2022"], loader: { ".css": "empty" }, plugins: [sveltePlugin("client")] });
      const serverEntry = join(outDirectory, "server.ts");
      const serverBundle = join(outDirectory, "server.mjs");
      await writeFile(serverEntry, `import { render } from "svelte/server"; import App from "./App.svelte"; export const html = render(App).body;`);
      await build({ entryPoints: [serverEntry], outfile: serverBundle, bundle: true, format: "esm", platform: "node",
        packages: "external", loader: { ".css": "empty" }, plugins: [sveltePlugin("server")] });
      const markup = (await import(pathToFileURL(serverBundle).href) as { html: string }).html;
      assert.match(markup, /<li[^>]*>1<\/li>/);
      outputs.set(mode, { bundle, markup, css });
    }
  }, 60_000);
  afterAll(async () => { if (directory !== "") await rm(directory, { recursive: true, force: true }); });

  for (const [engine, browserType] of [["Chromium", chromium], ["Firefox", firefox], ["WebKit", webkit]] as const satisfies ReadonlyArray<readonly [string, BrowserType]>) {
    for (const mode of ["application", "library"] as const) {
      for (const hydrate of [false, true]) {
        it(`${engine} ${mode} ${hydrate ? "hydration" : "mount"} preserves iteration shape, order, single refs and nonreactive membership`, async () => {
          const browser = await launchParityBrowser(browserType);
          const pages: Page[] = [];
          const errors: string[] = [];
          const warnings: string[] = [];
          try {
            const live = await browser.newPage(); pages.push(live);
            const svelte = await browser.newPage(); pages.push(svelte);
            const output = outputs.get(mode)!;
            for (const page of pages) {
              page.setDefaultTimeout(5_000);
              page.on("pageerror", (error) => errors.push(error.message));
              page.on("console", (message) => { if (message.type() === "warning") warnings.push(message.text()); });
              await page.route("https://app.example/**", (route) => {
                const url = route.request().url();
                if (url.endsWith("/refs.html")) return route.fulfill({ contentType: "text/html", body: source });
                if (url.endsWith("/refs.js")) return route.fulfill({ contentType: "text/javascript", body: controller });
                return route.fulfill({ contentType: "text/html", body: page === live
                  ? '<link rel="component" href="/refs.html"><main><x-refs id="case"></x-refs></main>'
                  : `<style>${output.css}</style><main>${hydrate ? output.markup : ""}</main>` });
              });
            }
            await Promise.all([live.goto("https://app.example/live"), svelte.goto("https://app.example/svelte")]);
            await live.addScriptTag({ path: liveBundle });
            await live.evaluate(() => (window as unknown as { HtmlNextLoader: { startBrowserComponents(): Promise<unknown> } }).HtmlNextLoader.startBrowserComponents());
            await svelte.addScriptTag({ path: output.bundle });
            await Promise.all(pages.map((page) => page.waitForFunction(() =>
              (window as unknown as { refsEffects: number }).refsEffects >= 1)));
            const compare = async () => {
              const [native, converted] = await Promise.all([snapshot(live), snapshot(svelte)]);
              assert.deepEqual(converted.behavior, native.behavior);
              assert.equal(native.behavior.effects, 1, "reading refs does not subscribe to membership changes");
              await assertPixelsEqual(svelte, converted.pixels, native.pixels, "Svelte ref pixels differ", live);
            };
            await compare();
            for (const rows of [[3, 2], [2, 3], [2], []]) {
              await Promise.all(pages.map((page) => page.evaluate((value) => {
                (window as unknown as { refsHost: { state: { rows: number[] } } }).refsHost.state.rows = value;
              }, rows)));
              await Promise.all(pages.map((page) => page.waitForFunction((expected) =>
                Array.from(document.querySelectorAll("#case ul li")).map((element) => element.textContent).join(",") === expected, rows.join(","))));
              await compare();
            }
            for (const later of [[7], []]) {
              await Promise.all(pages.map((page) => page.evaluate((value) => {
                (window as unknown as { refsHost: { state: { later: number[] } } }).refsHost.state.later = value;
              }, later)));
              await Promise.all(pages.map((page) => page.waitForFunction((expected) =>
                document.querySelectorAll("#case ol li").length === expected, later.length)));
              await compare();
            }
            for (const visible of [false, true]) {
              await Promise.all(pages.map((page) => page.evaluate((value) => {
                (window as unknown as { refsHost: { state: { visible: boolean } } }).refsHost.state.visible = value;
              }, visible)));
              await Promise.all(pages.map((page) => page.waitForFunction((expected) =>
                (document.querySelector("#case button") !== null) === expected, visible)));
              await compare();
            }
            assert.deepEqual(errors, []);
            assert.deepEqual(warnings.filter((message) => /hydration|mismatch/i.test(message)), []);
          } catch (error) {
            const observed = await Promise.all(pages.map((page) => page.evaluate(() => ({
              html: document.querySelector("main")?.innerHTML,
              effects: (window as unknown as { refsEffects?: number }).refsEffects,
            }))));
            throw new Error(JSON.stringify({ observed, errors, warnings }), { cause: error });
          } finally {
            await Promise.all(pages.map((page) => page.close()));
            await browser.close();
          }
        });
      }
    }
  }
});
