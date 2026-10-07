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

const enabled = process.env.HTMLNEXT_TARGET_TEST === "1";
const source = `<template component="x-html" status="early" summary="Sanitized markup."><defs>
  <state name="body" value="&lt;b title='safe'&gt;One&lt;/b&gt;&lt;img src=x onerror=alert(1)&gt;"></state>
  <handler name="change"><set name="body" value="&lt;i title='next'&gt;Two&lt;/i&gt;&lt;img src=x onerror=alert(1)&gt;"></set></handler>
</defs><article><div class="block" $html="$body"></div>
  <p>Before <template $html="$body"></template> after</p>
  <button type="button" on:click="change">Change</button></article>
<style>b { color: rgb(12 34 56); } i { color: rgb(65 43 21); }</style></template>`;

async function snapshot(page: Page) {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  return {
    behavior: await page.locator("article").evaluate((root) => ({
      blockTag: root.querySelector(".block")?.firstElementChild?.localName,
      blockTitle: root.querySelector(".block")?.firstElementChild?.getAttribute("title"),
      blockText: root.querySelector(".block")?.textContent,
      inlineText: root.querySelector("p")?.textContent,
      inlineTags: Array.from(root.querySelector("p")?.children ?? [], (child) => child.localName),
      boldColor: root.querySelector("b") ? getComputedStyle(root.querySelector("b")!).color : null,
      italicColor: root.querySelector("i") ? getComputedStyle(root.querySelector("i")!).color : null,
      unsafe: root.querySelectorAll("img, script, [onerror]").length,
    })),
    pixels: await page.locator("article").screenshot({ animations: "disabled" }),
  };
}

describe.skipIf(!enabled)("React sanitized HTML parity", () => {
  let directory = "";
  let liveBundle = "";
  let reactBundle = "";
  let serverMarkup = "";
  let css = "";

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-react-html-"));
    await writeFile(join(directory, "html.html"), source);
    const outDirectory = join(directory, "out");
    const manifest = await convertComponents({ mode: "application", target: "react", root: directory, outDirectory, entries: ["html.html"] });
    const style = manifest.output.artifacts.find((artifact) => artifact.kind === "style");
    css = style === undefined ? "" : await readFile(join(outDirectory, style.path), "utf8");
    const entry = join(outDirectory, "mount.tsx");
    await writeFile(entry, `import React from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import { XHtml } from "./react/application";
const main = document.querySelector("main")!;
if (main.hasChildNodes()) hydrateRoot(main, <XHtml />);
else createRoot(main).render(<XHtml />);`);
    reactBundle = join(outDirectory, "mount.js");
    await build({
      entryPoints: [entry], outfile: reactBundle, bundle: true, format: "iife", platform: "browser",
      target: ["es2022"], jsx: "automatic", loader: { ".css": "empty" },
      nodePaths: [fileURLToPath(new URL("../node_modules", import.meta.url))],
    });
    const server = await build({
      entryPoints: [join(outDirectory, manifest.output.entry)], bundle: true, write: false,
      platform: "node", format: "cjs", jsx: "automatic", packages: "external", loader: { ".css": "empty" },
    });
    const module = { exports: {} as Record<string, ComponentType<Record<string, unknown>>> };
    new Function("require", "module", "exports", server.outputFiles[0]!.text)(createRequire(import.meta.url), module, module.exports);
    serverMarkup = renderToString(createElement(module.exports.XHtml!));
    liveBundle = join(directory, "live.js");
    await build({
      entryPoints: [fileURLToPath(new URL("../../html-next/src/live.ts", import.meta.url))],
      outfile: liveBundle, bundle: true, format: "iife", globalName: "HtmlRuntime", platform: "browser", target: ["es2022"],
    });
  });

  afterAll(async () => { if (directory !== "") await rm(directory, { recursive: true, force: true }); });

  for (const [engine, browserType] of [["Chromium", chromium], ["Firefox", firefox], ["WebKit", webkit]] as const satisfies ReadonlyArray<readonly [string, BrowserType]>) {
    for (const hydrate of [false, true]) {
      it(`${engine} ${hydrate ? "hydration" : "mount"} matches live pixels and safe behavior before and after updates`, async () => {
        const browser = await launchParityBrowser(browserType);
        const live = await browser.newPage();
        const react = await browser.newPage();
        const errors: string[] = [];
        try {
          for (const page of [live, react]) page.on("pageerror", (error) => errors.push(error.message));
          await live.setContent(`${source}<main><x-html></x-html></main>`);
          await live.addScriptTag({ path: liveBundle });
          await live.evaluate(() => window.HtmlRuntime.lowerDocument());
          await react.setContent(`<style>${css}</style><main>${hydrate ? serverMarkup : ""}</main>`);
          await react.addScriptTag({ path: reactBundle });
          await Promise.all([live, react].map((page) => page.locator("article .block b").waitFor()));
          for (const expected of ["One", "Two"]) {
            await Promise.all([live, react].map((page) => page.waitForFunction((value) => document.querySelector(".block")?.textContent === value, expected)));
            const [native, converted] = await Promise.all([snapshot(live), snapshot(react)]);
            assert.deepEqual(converted.behavior, native.behavior);
            await assertPixelsEqual(react, converted.pixels, native.pixels, "React sanitized HTML pixels differ", live);
            if (expected === "One") await Promise.all([live, react].map((page) => page.locator("button").click()));
          }
          assert.deepEqual(errors, []);
        } finally {
          await live.close(); await react.close(); await browser.close();
        }
      });
    }
  }
});
