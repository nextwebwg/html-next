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

const base = `<template component="x-base-button" status="early" summary="Base button.">
  <button type="button" class="base" style="padding: 4px"><slot></slot></button>
  <style>:host { border: 2px solid rgb(20 70 130); padding: 4px; font: 16px/24px Arial, sans-serif; }</style>
</template>`;
const primary = `<template component="x-primary" status="early" summary="Primary button."><defs>
  <state type="boolean" name="active" value="false"></state>
  <handler name="toggle"><set name="active" expr:value="active = false"></set></handler>
</defs><x-base-button class="primary" style="padding: 6px" class:active="active" from:data-active="active" on:click="toggle"><slot></slot></x-base-button>
<style>:host { color: rgb(170 20 20); } :host(.active) { background: rgb(230 240 250); }</style></template>`;

async function snapshot(page: Page) {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  return {
    behavior: await page.locator("#case").evaluate((root) => ({
      tag: root.localName,
      component: root.getAttribute("data-component"),
      classes: root.className,
      active: root.getAttribute("data-active"),
      padding: getComputedStyle(root).padding,
      text: root.textContent,
    })),
    pixels: await page.locator("#case").screenshot({ animations: "disabled" }),
  };
}

describe.skipIf(process.env.HTMLNEXT_TARGET_TEST !== "1")("React delegated-root parity", () => {
  let directory = "";
  let liveBundle = "";
  let reactBundle = "";
  let serverMarkup = "";
  let css = "";

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-react-delegated-"));
    await writeFile(join(directory, "base.html"), base);
    await writeFile(join(directory, "primary.html"), `<link rel="component" href="./base.html">${primary}`);
    const outDirectory = join(directory, "out");
    const manifest = await convertComponents({ mode: "application", target: "react", root: directory, outDirectory, entries: ["*.html"] });
    css = (await Promise.all(manifest.output.artifacts.filter((artifact) => artifact.kind === "style")
      .map((artifact) => readFile(join(outDirectory, artifact.path), "utf8")))).join("\n");
    const entry = join(outDirectory, "mount.tsx");
    await writeFile(entry, `import React from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import { XPrimary } from "./react/application";
const mount = document.querySelector("main")!;
const element = <XPrimary id="case">Go</XPrimary>;
if (mount.hasChildNodes()) hydrateRoot(mount, element);
else createRoot(mount).render(element);`);
    reactBundle = join(outDirectory, "mount.js");
    await build({ entryPoints: [entry], outfile: reactBundle, bundle: true, format: "iife", platform: "browser",
      target: ["es2022"], jsx: "automatic", loader: { ".css": "empty" },
      nodePaths: [fileURLToPath(new URL("../node_modules", import.meta.url))] });
    const server = await build({ entryPoints: [join(outDirectory, manifest.output.entry)], bundle: true, write: false,
      platform: "node", format: "cjs", jsx: "automatic", packages: "external", loader: { ".css": "empty" } });
    const module = { exports: {} as Record<string, ComponentType<Record<string, unknown>>> };
    new Function("require", "module", "exports", server.outputFiles[0]!.text)(createRequire(import.meta.url), module, module.exports);
    serverMarkup = renderToString(createElement(module.exports.XPrimary!, { id: "case", children: "Go" }));
    assert.match(serverMarkup, /^<button\b/);
    assert.match(serverMarkup, /data-component="x-primary x-base-button"/);
    liveBundle = join(directory, "live.js");
    await build({ entryPoints: [fileURLToPath(new URL("../../html-next/src/live.ts", import.meta.url))],
      outfile: liveBundle, bundle: true, format: "iife", globalName: "HtmlRuntime", platform: "browser", target: ["es2022"] });
  });

  afterAll(async () => { if (directory !== "") await rm(directory, { recursive: true, force: true }); });

  for (const [engine, browserType] of [["Chromium", chromium], ["Firefox", firefox], ["WebKit", webkit]] as const satisfies ReadonlyArray<readonly [string, BrowserType]>) {
    for (const hydrate of [false, true]) {
      it(`${engine} ${hydrate ? "hydration" : "mount"} keeps one native root, reactive behavior, and pixels`, async () => {
        const browser = await launchParityBrowser(browserType);
        const pages: Page[] = [];
        const errors: string[] = [];
        const warnings: string[] = [];
        try {
          const live = await browser.newPage(); pages.push(live);
          const react = await browser.newPage(); pages.push(react);
          react.on("console", (message) => { if (message.type() === "warning" || message.type() === "error") warnings.push(message.text()); });
          for (const page of pages) page.on("pageerror", (error) => errors.push(error.message));
          await live.setContent(`${base}${primary}<main><x-primary id="case">Go</x-primary></main>`);
          await live.addScriptTag({ path: liveBundle });
          await live.evaluate(() => (window as unknown as { HtmlRuntime: { lowerDocument(): void } }).HtmlRuntime.lowerDocument());
          await react.setContent(`<style>${css}</style><main>${hydrate ? serverMarkup : ""}</main>`);
          await react.addScriptTag({ path: reactBundle });
          await Promise.all(pages.map((page) => page.locator("#case").waitFor()));
          for (const [index, active] of [null, "", null].entries()) {
            try {
              await Promise.all(pages.map((page) => page.waitForFunction((expected) => document.querySelector("#case")?.getAttribute("data-active") === expected, active, { timeout: 3000 })));
            } catch (error) {
              const state = await Promise.all(pages.map((page) => page.locator("#case").evaluate((root) => root.outerHTML)));
              throw new Error(`Waiting for ${active}: ${JSON.stringify({ state, errors, warnings })}`, { cause: error });
            }
            const [native, converted] = await Promise.all([snapshot(live), snapshot(react)]);
            assert.deepEqual(converted.behavior, native.behavior);
            assert.equal(native.behavior.tag, "button");
            assert.equal(native.behavior.active, active);
            await assertPixelsEqual(react, converted.pixels, native.pixels, "React delegated-root pixels differ", live);
            if (index < 2) await Promise.all(pages.map((page) => page.locator("#case").click()));
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
});
