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

import { convertComponents, type ConversionGraph } from "../src/index.js";
import { assertPixelsEqual, launchParityBrowser } from "../../html-next/tests/pixel-parity.js";

const enabled = process.env.HTMLNEXT_TARGET_TEST === "1";
const child = `<template component="x-graph-item" status="early" summary="Graph child."><defs>
  <prop name="label" type="string" default="Initial">Item label.</prop>
  <event name="saved" type="number"></event>
  <handler name="save"><dispatch event="saved" expr:value="1"></dispatch></handler>
</defs><li on:click="save"><slot></slot><output $value="label"></output></li>
<style>:host { color: rgb(20 40 80); } :slotted(strong) { color: rgb(90 30 60); }</style></template>`;
const parent = `<template component="x-graph-list" status="early" summary="Graph parent."><defs>
  <state type="number" name="count" value="0"></state>
  <state type="boolean" name="active" value="true"></state>
  <state type="number" name="saved" value="0"></state>
  <state type="number" name="ancestorSaved" value="0"></state>
  <handler name="increment"><set name="count" expr:value="count + 1"></set><set name="active" expr:value="not active"></set></handler>
  <handler name="recordSaved"><set name="saved" expr:value="saved + 1"></set></handler>
  <handler name="recordAncestorSaved"><set name="ancestorSaved" expr:value="ancestorSaved + 1"></set></handler>
</defs><section on:saved="recordAncestorSaved"><button type="button" on:click="increment">Increment</button>
  <ul><x-graph-item from:label="count = 0 ? 'Item0' : 'Item1'" on:saved.stop="recordSaved"><strong>Child: </strong></x-graph-item></ul>
  <output class="saved" $value="saved"></output><output class="ancestor-saved" $value="ancestorSaved"></output>
</section><style>:host { display: block; padding: 8px; background: rgb(225 235 245); }
  :host-state([active]) { background: rgb(200 220 240); }</style></template>`;

async function snapshot(page: Page) {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  return {
    behavior: await page.locator("#case").evaluate((root) => {
      const item = root.querySelector("li")!;
      return {
        root: root.localName,
        text: item.textContent?.replace(/\s/g, ""),
        saved: root.querySelector("output.saved")?.textContent,
        ancestorSaved: root.querySelector("output.ancestor-saved")?.textContent,
        color: getComputedStyle(item).color,
        projectedColor: getComputedStyle(item.querySelector("strong")!).color,
        background: getComputedStyle(root).backgroundColor,
      };
    }),
    pixels: await page.locator("#case").screenshot({ animations: "disabled" }),
  };
}

describe.skipIf(!enabled)("public React nested graph parity", () => {
  let directory = "";
  let liveBundle = "";
  const converted = new Map<ConversionGraph, { readonly bundle: string; readonly css: string; readonly server: string }>();

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-react-graph-"));
    await mkdir(join(directory, "components"));
    await writeFile(join(directory, "components", "item.html"), child);
    await writeFile(join(directory, "components", "list.html"), `<link rel="component" href="./item.html">${parent}`);
    liveBundle = join(directory, "live.js");
    await build({ entryPoints: [fileURLToPath(new URL("../../html-next/src/live.ts", import.meta.url))],
      outfile: liveBundle, bundle: true, format: "iife", globalName: "HtmlRuntime", platform: "browser", target: ["es2022"] });
    for (const mode of ["application", "library"] as const) {
      const outDirectory = join(directory, mode);
      const manifest = await convertComponents({ mode, target: "react", root: directory, outDirectory,
        entries: ["components/list.html"] });
      assert.deepEqual(manifest.components.map((component) => component.tag).sort(), ["x-graph-item", "x-graph-list"]);
      assert.deepEqual(manifest.entries.map((entry) => entry.tag), ["x-graph-list"]);
      assert.equal(manifest.output.entry, `react/${mode === "application" ? "application" : "index"}.ts`);
      const css = (await Promise.all(manifest.output.artifacts.filter((artifact) => artifact.kind === "style")
        .map((artifact) => readFile(join(outDirectory, artifact.path), "utf8")))).join("\n");
      const entry = join(outDirectory, "mount.tsx");
      const bundle = join(outDirectory, "mount.js");
      await writeFile(entry, `import React from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import { XGraphList } from "./${manifest.output.entry.replace(/\.ts$/, "")}";
const mount = document.querySelector("main")!;
if (mount.hasChildNodes()) hydrateRoot(mount, <XGraphList id="case" />);
else createRoot(mount).render(<XGraphList id="case" />);`);
      await build({ entryPoints: [entry], outfile: bundle, bundle: true, format: "iife", platform: "browser",
        target: ["es2022"], jsx: "automatic", loader: { ".css": "empty" },
        nodePaths: [fileURLToPath(new URL("../node_modules", import.meta.url))] });
      const server = await build({ entryPoints: [join(outDirectory, manifest.output.entry)], bundle: true, write: false,
        platform: "node", format: "cjs", jsx: "automatic", packages: "external", loader: { ".css": "empty" } });
      const module = { exports: {} as Record<string, ComponentType<Record<string, unknown>>> };
      new Function("require", "module", "exports", server.outputFiles[0]!.text)(createRequire(import.meta.url), module, module.exports);
      converted.set(mode, { bundle, css, server: renderToString(createElement(module.exports.XGraphList!, { id: "case" })) });
    }
  });

  afterAll(async () => { if (directory !== "") await rm(directory, { recursive: true, force: true }); });

  for (const mode of ["application", "library"] as const) {
    for (const [engine, browserType] of [["Chromium", chromium], ["Firefox", firefox], ["WebKit", webkit]] as const satisfies ReadonlyArray<readonly [string, BrowserType]>) {
      it(`${engine} ${mode} matches nested mount, SSR, hydration, updates, styles, and events`, async () => {
        const browser = await launchParityBrowser(browserType);
        const [live, react, hydrated] = await Promise.all([browser.newPage(), browser.newPage(), browser.newPage()]);
        const pages = [live, react, hydrated];
        const errors: string[] = [];
        const recoveries: string[] = [];
        try {
          const output = converted.get(mode)!;
          for (const page of pages) page.on("pageerror", (error) => errors.push(error.message));
          await Promise.all([
            live.setContent(`${child}${parent}<main><x-graph-list id="case"></x-graph-list></main>`),
            react.setContent(`<style>${output.css}</style><main></main>`),
            hydrated.setContent(`<style>${output.css}</style><main>${output.server}</main>`),
          ]);
          await live.addScriptTag({ path: liveBundle });
          await live.evaluate(() => window.HtmlRuntime.lowerDocument());
          const [nativeServer, convertedServer] = await Promise.all([snapshot(live), snapshot(hydrated)]);
          assert.deepEqual(convertedServer.behavior, nativeServer.behavior, "nested server markup differs");
          await assertPixelsEqual(hydrated, convertedServer.pixels, nativeServer.pixels, "nested server pixels differ", live);
          hydrated.on("console", (message) => { if (/hydration|mismatch/i.test(message.text())) recoveries.push(message.text()); });
          await Promise.all([react.addScriptTag({ path: output.bundle }), hydrated.addScriptTag({ path: output.bundle })]);
          for (const expected of ["Child:Item0", "Child:Item1"] as const) {
            await Promise.all(pages.map((page) => page.waitForFunction((value) =>
              document.querySelector("#case li")?.textContent?.replace(/\s/g, "") === value, expected)));
            const [native, mounted, claimed] = await Promise.all([
              expected === "Child:Item0" ? Promise.resolve(nativeServer) : snapshot(live), snapshot(react), snapshot(hydrated),
            ]);
            assert.deepEqual(mounted.behavior, native.behavior);
            assert.deepEqual(claimed.behavior, native.behavior);
            await assertPixelsEqual(react, mounted.pixels, native.pixels, "nested mount pixels differ", live);
            await assertPixelsEqual(hydrated, claimed.pixels, native.pixels, "nested hydration pixels differ", live);
            assert.equal(native.behavior.saved, "0");
            assert.equal(native.behavior.ancestorSaved, "0");
            assert.equal(native.behavior.background, expected === "Child:Item0" ? "rgb(200, 220, 240)" : "rgb(225, 235, 245)");
            assert.equal(native.behavior.projectedColor, "rgb(90, 30, 60)");
            if (expected === "Child:Item0") await Promise.all(pages.map((page) => page.getByRole("button", { name: "Increment" }).click()));
          }
          await Promise.all(pages.map((page) => page.locator("#case li").click()));
          const [nativeEvent, mountedEvent, claimedEvent] = await Promise.all([snapshot(live), snapshot(react), snapshot(hydrated)]);
          assert.deepEqual(mountedEvent.behavior, nativeEvent.behavior);
          assert.deepEqual(claimedEvent.behavior, nativeEvent.behavior);
          await assertPixelsEqual(react, mountedEvent.pixels, nativeEvent.pixels, "nested event pixels differ", live);
          await assertPixelsEqual(hydrated, claimedEvent.pixels, nativeEvent.pixels, "nested hydrated event pixels differ", live);
          assert.equal(nativeEvent.behavior.saved, "1");
          assert.equal(nativeEvent.behavior.ancestorSaved, "0");
          assert.deepEqual(recoveries, []);
          assert.deepEqual(errors, []);
        } finally {
          await Promise.all(pages.map((page) => page.close()));
          await browser.close();
        }
      });
    }
  }
});
