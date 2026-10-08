import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
const panel = `<template component="x-panel" status="early" summary="Panel."><section>
  <header><slot name="title"><b>Untitled</b></slot></header>
  <main><slot><i>Empty</i></slot></main>
</section><style>:host { display: block; background: rgb(238 244 250); padding: 4px; } header { color: rgb(32 48 64); } :slotted(h2) { color: rgb(200 20 30); }</style></template>`;
const app = `<template component="x-app" status="early" summary="App."><defs>
  <state name="title" value="Title"></state>
  <handler name="change"><set name="title" value="Changed"></set></handler>
</defs><article><x-panel><h2 slot="title" $value="$title"></h2><p>Body</p></x-panel>
  <x-panel></x-panel><button type="button" on:click="change">Change</button></article></template>`;

async function snapshot(page: Page) {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  return {
    behavior: await page.locator("article").evaluate((root) => ({
      titles: Array.from(root.querySelectorAll("section header"), (header) => header.textContent?.trim()),
      bodies: Array.from(root.querySelectorAll("section main"), (main) => main.textContent?.trim()),
      color: getComputedStyle(root.querySelector("section header")!).color,
      projectedColor: getComputedStyle(root.querySelector("section h2")!).color,
    })),
    pixels: await page.locator("article").screenshot({ animations: "disabled" }),
  };
}

describe.skipIf(!enabled)("React named slot parity", () => {
  let directory = "";
  let liveBundle = "";
  let reactBundle = "";
  let serverMarkup = "";
  let css = "";

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-react-slot-"));
    await mkdir(join(directory, "components"));
    await writeFile(join(directory, "components/panel.html"), panel);
    await writeFile(join(directory, "components/app.html"), `<link rel="component" href="./panel.html">${app}`);
    const outDirectory = join(directory, "out");
    const manifest = await convertComponents({ mode: "application", target: "react", root: directory, outDirectory, entries: ["components/**"] });
    css = (await Promise.all(manifest.output.artifacts.filter((artifact) => artifact.kind === "style")
      .map((artifact) => readFile(join(outDirectory, artifact.path), "utf8")))).join("\n");
    const entry = join(outDirectory, "mount.tsx");
    await writeFile(entry, `import React from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import { XApp } from "./react/application";
const main = document.querySelector("main")!;
if (main.hasChildNodes()) hydrateRoot(main, <XApp />);
else createRoot(main).render(<XApp />);`);
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
    serverMarkup = renderToString(createElement(module.exports.XApp!));
    liveBundle = join(directory, "live.js");
    await build({
      entryPoints: [fileURLToPath(new URL("../../html-next/src/live.ts", import.meta.url))],
      outfile: liveBundle, bundle: true, format: "iife", globalName: "HtmlRuntime", platform: "browser", target: ["es2022"],
    });
  });

  afterAll(async () => { if (directory !== "") await rm(directory, { recursive: true, force: true }); });

  for (const [engine, browserType] of [["Chromium", chromium], ["Firefox", firefox], ["WebKit", webkit]] as const satisfies ReadonlyArray<readonly [string, BrowserType]>) {
    for (const hydrate of [false, true]) {
      it(`${engine} ${hydrate ? "hydration" : "mount"} matches projected and fallback slots through updates`, async () => {
        const browser = await launchParityBrowser(browserType);
        const live = await browser.newPage();
        const react = await browser.newPage();
        const errors: string[] = [];
        try {
          for (const page of [live, react]) page.on("pageerror", (error) => errors.push(error.message));
          await live.setContent(`${panel}${app}<main><x-app></x-app></main>`);
          await live.addScriptTag({ path: liveBundle });
          await live.evaluate(() => window.HtmlRuntime.lowerDocument());
          await react.setContent(`<style>${css}</style><main>${hydrate ? serverMarkup : ""}</main>`);
          await react.addScriptTag({ path: reactBundle });
          try {
            await Promise.all([live, react].map((page) => page.locator("article section header").first().waitFor({ timeout: 5000 })));
          } catch (error) {
            const markup = await Promise.all([live, react].map((page) => page.locator("body > main").evaluate((main) => main.innerHTML)));
            throw new Error(`Slot roots did not mount: live=${markup[0]} react=${markup[1]} errors=${JSON.stringify(errors)}`, { cause: error });
          }
          for (const expected of ["Title", "Changed"]) {
            await Promise.all([live, react].map((page) => page.waitForFunction((value) => document.querySelector("article section header")?.textContent?.trim() === value, expected)));
            const [native, converted] = await Promise.all([snapshot(live), snapshot(react)]);
            assert.deepEqual(converted.behavior, native.behavior);
            await assertPixelsEqual(react, converted.pixels, native.pixels, "React named slot pixels differ", live);
            if (expected === "Title") await Promise.all([live, react].map((page) => page.locator("button").click()));
          }
          assert.deepEqual(errors, []);
        } finally {
          await live.close(); await react.close(); await browser.close();
        }
      });
    }
  }
});
