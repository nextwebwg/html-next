import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

describe.skipIf(process.env.HTMLNEXT_TARGET_TEST !== "1")("React polymorphic-root parity", () => {
  let directory = "";
  let liveBundle = "";
  const outputs = new Map<"application" | "library", { reactBundle: string; serverMarkup: string; css: string }>();

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-react-polymorphic-"));
    await writeFile(join(directory, "switch.html"), source);
    await writeFile(join(directory, "switch.js"), controller);
    for (const mode of ["application", "library"] as const) {
      const outDirectory = join(directory, `out-${mode}`);
      const manifest = await convertComponents({ mode, target: "react", root: directory, outDirectory, entries: ["switch.html"] });
      const css = (await Promise.all(manifest.output.artifacts.filter((artifact) => artifact.kind === "style")
        .map((artifact) => readFile(join(outDirectory, artifact.path), "utf8")))).join("\n");
      const entry = join(outDirectory, "mount.tsx");
      await writeFile(entry, `import React from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import { XSwitch } from "./react/${mode === "application" ? "application" : "index"}";
const mount = document.querySelector("main")!;
const element = <XSwitch id="case" />;
if (mount.hasChildNodes()) hydrateRoot(mount, element);
else createRoot(mount).render(element);`);
      const reactBundle = join(outDirectory, "mount.js");
      await build({ entryPoints: [entry], outfile: reactBundle, bundle: true, format: "iife", platform: "browser",
        target: ["es2022"], jsx: "automatic", loader: { ".css": "empty" },
        nodePaths: [fileURLToPath(new URL("../node_modules", import.meta.url))] });
      const server = await build({ entryPoints: [join(outDirectory, manifest.output.entry)], bundle: true, write: false,
        platform: "node", format: "cjs", jsx: "automatic", packages: "external", loader: { ".css": "empty" } });
      const module = { exports: {} as Record<string, ComponentType<Record<string, unknown>>> };
      new Function("require", "module", "exports", server.outputFiles[0]!.text)(createRequire(import.meta.url), module, module.exports);
      const serverMarkup = renderToString(createElement(module.exports.XSwitch!, { id: "case" }));
      assert.match(serverMarkup, /^<button\b/);
      outputs.set(mode, { reactBundle, serverMarkup, css });
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
        const { reactBundle, serverMarkup, css } = outputs.get(mode)!;
        const browser = await launchParityBrowser(browserType);
        const pages: Page[] = [];
        const errors: string[] = [];
        const warnings: string[] = [];
        try {
          const live = await browser.newPage(); pages.push(live);
          const react = await browser.newPage(); pages.push(react);
          react.on("console", (message) => { if (message.type() === "warning" || message.type() === "error") warnings.push(message.text()); });
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
          await Promise.all([live.goto("https://app.example/live"), react.goto("https://app.example/react")]);
          await live.evaluate(() => {
            const globals = window as unknown as { switchTrace: string[][]; switchEffects: string[] };
            globals.switchTrace = []; globals.switchEffects = [];
          });
          await live.addScriptTag({ path: liveBundle });
          await live.evaluate(() => (window as unknown as { HtmlNextLoader: { startBrowserComponents(): Promise<unknown> } })
            .HtmlNextLoader.startBrowserComponents());
          await react.evaluate(() => {
            const globals = window as unknown as { switchTrace: string[][]; switchEffects: string[] };
            globals.switchTrace = []; globals.switchEffects = [];
          });
          await react.addScriptTag({ path: reactBundle });
          for (const [index, tag] of ["button", "a", "button"].entries()) {
            await Promise.all(pages.map((page) => page.waitForFunction((expected) => document.querySelector("#case")?.localName === expected, tag)));
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
            const [native, converted] = await Promise.all([snapshot(live), snapshot(react)]);
            assert.deepEqual(converted.behavior, native.behavior);
            await assertPixelsEqual(react, converted.pixels, native.pixels, "React polymorphic-root pixels differ", live);
            const expectedTrace = [["connect", "button"]];
            assert.deepEqual(await live.evaluate(() => (window as unknown as { switchTrace: string[][] }).switchTrace), expectedTrace);
            assert.deepEqual(await react.evaluate(() => (window as unknown as { switchTrace: string[][] }).switchTrace), expectedTrace);
            const expectedEffects = ["button", "a", "button"].slice(0, index + 1);
            assert.deepEqual(await live.evaluate(() => (window as unknown as { switchEffects: string[] }).switchEffects), expectedEffects);
            assert.deepEqual(await react.evaluate(() => (window as unknown as { switchEffects: string[] }).switchEffects), expectedEffects);
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
