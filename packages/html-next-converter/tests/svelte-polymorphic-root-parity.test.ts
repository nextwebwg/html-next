import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, it } from "vitest";

import { build } from "esbuild";
import { sveltePlugin } from "./helpers/svelte.js";
import { chromium, firefox, webkit, type BrowserType, type Page } from "playwright";

import { convertComponents } from "../src/index.js";
import { assertPixelsEqual, launchParityBrowser } from "../../html-next/tests/pixel-parity.js";

import { polymorphicControllerSource as source, polymorphicControllerModule as controller } from "./fixtures/polymorphic-controller.js";

async function snapshot(page: Page) {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  return {
    behavior: await page.locator("#case").evaluate((root) => ({
      tag: root.localName,
      text: root.textContent,
      component: root.getAttribute("data-component"),
      controllerRoot: root.getAttribute("data-controller-root"),
      focused: document.activeElement === root,
    })),
    pixels: await page.locator("#case").screenshot({ animations: "disabled" }),
  };
}

describe.skipIf(process.env.HTMLNEXT_TARGET_TEST !== "1")("Svelte polymorphic-root parity", () => {
  let directory = "";
  let liveBundle = "";
  const outputs = new Map<"application" | "library", { svelteBundle: string; serverMarkup: string; css: string }>();

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-svelte-polymorphic-"));
    await symlink(fileURLToPath(new URL("../node_modules", import.meta.url)), join(directory, "node_modules"), "dir");
    await writeFile(join(directory, "switch.html"), source);
    await writeFile(join(directory, "switch.js"), controller);
    for (const mode of ["application", "library"] as const) {
      const outDirectory = join(directory, `out-${mode}`);
      const manifest = await convertComponents({ mode, target: "svelte", root: directory, outDirectory, entries: ["switch.html"] });
      const css = (await Promise.all(manifest.output.artifacts.filter((artifact) => artifact.kind === "style")
        .map((artifact) => readFile(join(outDirectory, artifact.path), "utf8")))).join("\n");
      const app = join(outDirectory, "App.svelte");
      await writeFile(app, `<script>import XSwitch from "./${manifest.components[0]!.artifact}";</script><XSwitch id="case" />`);
      const entry = join(outDirectory, "mount.ts");
      await writeFile(entry, `import { mount, hydrate } from "svelte"; import App from "./App.svelte";
const target = document.querySelector("main")!;
if (target.hasChildNodes()) hydrate(App, { target }); else mount(App, { target });`);
      const svelteBundle = join(outDirectory, "mount.js");
      await build({ entryPoints: [entry], outfile: svelteBundle, bundle: true, format: "iife", platform: "browser",
        target: ["es2022"], loader: { ".css": "empty" }, plugins: [sveltePlugin("client")] });
      const serverEntry = join(outDirectory, "server.ts");
      const serverBundle = join(outDirectory, "server.mjs");
      await writeFile(serverEntry, `import { render } from "svelte/server"; import App from "./App.svelte"; export const html = render(App).body;`);
      await build({ entryPoints: [serverEntry], outfile: serverBundle, bundle: true, format: "esm", platform: "node",
        packages: "external", loader: { ".css": "empty" }, plugins: [sveltePlugin("server")] });
      const serverMarkup = (await import(pathToFileURL(serverBundle).href) as { html: string }).html;
      assert.match(serverMarkup, /<button\b/);
      outputs.set(mode, { svelteBundle, serverMarkup, css });
    }
    liveBundle = join(directory, "live.js");
    await build({ entryPoints: [fileURLToPath(new URL("../../html-next/src/browser-loader.ts", import.meta.url))],
      outfile: liveBundle, bundle: true, format: "iife", globalName: "HtmlNextLoader", platform: "browser", target: ["es2022"] });
  });

  afterAll(async () => { if (directory !== "") await rm(directory, { recursive: true, force: true }); });

  for (const [engine, browserType] of [["Chromium", chromium], ["Firefox", firefox], ["WebKit", webkit]] as const satisfies ReadonlyArray<readonly [string, BrowserType]>) {
    for (const mode of ["application", "library"] as const) {
      for (const hydrate of [false, true]) {
        it(`${engine} ${mode} ${hydrate ? "hydration" : "mount"} retains native root behavior and focus through switches`, async () => {
        const { svelteBundle, serverMarkup, css } = outputs.get(mode)!;
        const browser = await launchParityBrowser(browserType);
        const pages: Page[] = [];
        const errors: string[] = [];
        const warnings: string[] = [];
        try {
          const live = await browser.newPage(); pages.push(live);
          const svelte = await browser.newPage(); pages.push(svelte);
          svelte.on("console", (message) => { if (message.type() === "warning" || message.type() === "error") warnings.push(message.text()); });
          for (const page of pages) {
            page.on("pageerror", (error) => errors.push(error.message));
            await page.route("https://app.example/**", (route) => {
              const url = route.request().url();
              if (url.endsWith("/switch.html")) return route.fulfill({ contentType: "text/html", body: source });
              if (url.endsWith("/switch.js")) return route.fulfill({ contentType: "text/javascript", body: controller });
              return route.fulfill({ contentType: "text/html", body: page === live
                ? '<link rel="component" href="/switch.html"><main><x-switch id="case"></x-switch></main>'
                : `<style>${css}</style><main>${hydrate ? serverMarkup : ""}</main>` });
            });
          }
          await Promise.all([live.goto("https://app.example/live"), svelte.goto("https://app.example/svelte")]);
          await live.evaluate(() => {
            const globals = window as unknown as { switchTrace: string[][]; switchEffects: string[] };
            globals.switchTrace = []; globals.switchEffects = [];
          });
          await live.addScriptTag({ path: liveBundle });
          await live.evaluate(() => (window as unknown as { HtmlNextLoader: { startBrowserComponents(): Promise<unknown> } })
            .HtmlNextLoader.startBrowserComponents());
          await svelte.evaluate(() => {
            const globals = window as unknown as { switchTrace: string[][]; switchEffects: string[] };
            globals.switchTrace = []; globals.switchEffects = [];
          });
          await svelte.addScriptTag({ path: svelteBundle });
          for (const [index, tag] of ["button", "a", "button"].entries()) {
            await Promise.all(pages.map((page) => page.waitForFunction((expected) => document.querySelector("#case")?.localName === expected, tag, { timeout: 5_000 })));
            try {
              await Promise.all(pages.map((page) => page.waitForFunction((expected) => {
                const globals = window as unknown as { switchTrace: string[][]; switchEffects: string[] };
                return globals.switchTrace.length === 1 && globals.switchEffects.length === expected;
              }, index + 1, { timeout: 5_000 })));
            } catch (error) {
              const traces = await Promise.all(pages.map((page) => page.evaluate(() => {
                const globals = window as unknown as { switchTrace: string[][]; switchEffects: string[] };
                return { transitions: globals.switchTrace, effects: globals.switchEffects };
              })));
              throw new Error(`Missing controller transition: ${JSON.stringify({ index, traces, errors, warnings })}`, { cause: error });
            }
            const [native, converted] = await Promise.all([snapshot(live), snapshot(svelte)]);
            assert.deepEqual(converted.behavior, native.behavior);
            await assertPixelsEqual(svelte, converted.pixels, native.pixels, "Svelte polymorphic-root pixels differ", live);
            const expectedTrace = [["connect", "button"]];
            assert.deepEqual(await live.evaluate(() => (window as unknown as { switchTrace: string[][] }).switchTrace), expectedTrace);
            assert.deepEqual(await svelte.evaluate(() => (window as unknown as { switchTrace: string[][] }).switchTrace), expectedTrace);
            const expectedEffects = ["button", "a", "button"].slice(0, index + 1);
            assert.deepEqual(await live.evaluate(() => (window as unknown as { switchEffects: string[] }).switchEffects), expectedEffects);
            assert.deepEqual(await svelte.evaluate(() => (window as unknown as { switchEffects: string[] }).switchEffects), expectedEffects);
            if (index < 2) await Promise.all(pages.map(async (page) => {
              await page.locator("#case").focus();
              await page.locator("#case").press("Enter");
            }));
          }
          assert.deepEqual(errors, []);
          assert.deepEqual(warnings.filter((message) => /hydration|mismatch/i.test(message)), []);
        } finally {
          await Promise.all(pages.map((page) => page.close()));
          await browser.close();
        }
      });
      }
    }
  }
});
