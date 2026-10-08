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
const source = `<template component="x-nested-set" status="early" summary="Nested handler paths."><defs>
  <state type="object({ rows: list(object({ name: string })), selected: number })" name="form" value="{ rows: [{ name: 'Ada' }, { name: 'Bea' }], selected: 1 }"></state>
  <state type="number" name="missingIndex" value="9"></state>
  <state type="number" name="count" value="2"></state>
  <state type="object({ '9007199254740992': object({ name: string }), '9007199254740993': object({ name: string }), '01': object({ name: string }) })" name="byId" value="{ '9007199254740992': { name: 'Wrong' }, '9007199254740993': { name: 'Right' }, '01': { name: 'Leading' } }"></state>
  <handler name="rename"><set name="form.rows[$form.selected].name" value="Ann"></set>
    <set name="form.selected" expr:value="$form.selected - 1"></set>
    <set name="form.rows[$form.selected].name" value="Zoe"></set></handler>
  <handler name="missing"><set name="form.rows[$missingIndex].name" value="Ignored"></set></handler>
  <handler name="wrongNumber"><set name="count" expr:value="concat($count)"></set></handler>
  <handler name="wrongField"><set name="form.rows[$form.selected].name" expr:value="7"></set></handler>
  <handler name="bump"><set name="count" expr:value="$count + 1"></set></handler>
</defs><section><button class="rename" type="button" on:click="rename">Rename</button>
  <button class="missing" type="button" on:click="missing">Missing</button>
  <button class="wrong-number" type="button" on:click="wrongNumber">Wrong number</button>
  <button class="wrong-field" type="button" on:click="wrongField">Wrong field</button>
  <button class="bump" type="button" on:click="bump">Bump</button>
  <output class="first" $value="$form.rows.0.name"></output>
  <output class="second" $value="$form.rows.1.name"></output>
  <output class="bracket-first" $value="$form.rows[0].name"></output>
  <output class="bracket-selected" $value="$form.rows[$form.selected].name"></output>
  <output class="large-key" $value="$byId[9007199254740993].name"></output>
  <output class="leading-key" $value="$byId[01].name"></output>
  <output class="selected" $value="$form.selected"></output>
  <output class="count" $value="$count"></output></section>
<style>:host { display: block; padding: 4px; font: 16px/24px Arial, sans-serif; }
  output { display: inline-block; min-width: 32px; }</style></template>`;

async function snapshot(page: Page) {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  return {
    behavior: await page.locator("section").evaluate((root) => ({
      first: root.querySelector(".first")?.textContent,
      second: root.querySelector(".second")?.textContent,
      selected: root.querySelector(".selected")?.textContent,
      count: root.querySelector(".count")?.textContent,
    })),
    brackets: await page.locator("section").evaluate((root) => ({
      first: root.querySelector(".bracket-first")?.textContent,
      selected: root.querySelector(".bracket-selected")?.textContent,
      large: root.querySelector(".large-key")?.textContent,
      leading: root.querySelector(".leading-key")?.textContent,
    })),
    pixels: await page.locator("section").screenshot({ animations: "disabled" }),
  };
}

describe.skipIf(!enabled)("React nested handler parity", () => {
  let directory = "";
  let liveBundle = "";
  let reactBundle = "";
  let serverMarkup = "";
  let css = "";

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-react-nested-handler-"));
    await writeFile(join(directory, "component.html"), source);
    const outDirectory = join(directory, "out");
    const manifest = await convertComponents({ mode: "application", target: "react", root: directory, outDirectory, entries: ["component.html"] });
    css = (await Promise.all(manifest.output.artifacts.filter((artifact) => artifact.kind === "style")
      .map((artifact) => readFile(join(outDirectory, artifact.path), "utf8")))).join("\n");
    const entry = join(outDirectory, "mount.tsx");
    await writeFile(entry, `import React from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import { XNestedSet } from "./react/application";
const mount = document.querySelector("main")!;
if (mount.hasChildNodes()) hydrateRoot(mount, <XNestedSet />);
else createRoot(mount).render(<XNestedSet />);`);
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
    serverMarkup = renderToString(createElement(module.exports.XNestedSet!));
    liveBundle = join(directory, "live.js");
    await build({
      entryPoints: [fileURLToPath(new URL("../../html-next/src/live.ts", import.meta.url))],
      outfile: liveBundle, bundle: true, format: "iife", globalName: "HtmlRuntime", platform: "browser", target: ["es2022"],
    });
  });

  afterAll(async () => { if (directory !== "") await rm(directory, { recursive: true, force: true }); });

  for (const [engine, browserType] of [["Chromium", chromium], ["Firefox", firefox], ["WebKit", webkit]] as const satisfies ReadonlyArray<readonly [string, BrowserType]>) {
    for (const hydrate of [false, true]) {
      it(`${engine} ${hydrate ? "hydration" : "mount"} matches sequential nested writes`, async () => {
        const browser = await launchParityBrowser(browserType);
        const live = await browser.newPage();
        const react = await browser.newPage();
        const errors: string[] = [];
        try {
          for (const page of [live, react]) page.on("pageerror", (error) => errors.push(error.message));
          await live.setContent(`${source}<main><x-nested-set></x-nested-set></main>`);
          await live.addScriptTag({ path: liveBundle });
          await live.evaluate(() => window.HtmlRuntime.lowerDocument());
          await react.setContent(`<style>${css}</style><main>${hydrate ? serverMarkup : ""}</main>`);
          await react.addScriptTag({ path: reactBundle });
          await Promise.all([live, react].map((page) => page.locator("section output.first").waitFor()));
          for (const expected of [
            { first: "Ada", second: "Bea", selected: "1", count: "2" },
            { first: "Zoe", second: "Ann", selected: "0", count: "2" },
          ]) {
            await Promise.all([live, react].map((page) => page.waitForFunction((value) =>
              document.querySelector("output.first")?.textContent === value, expected.first)));
            const [native, converted] = await Promise.all([snapshot(live), snapshot(react)]);
            assert.deepEqual(converted.behavior, native.behavior);
            assert.deepEqual(native.behavior, expected);
            assert.deepEqual(converted.brackets, native.brackets);
            assert.deepEqual(native.brackets, {
              first: expected.first,
              selected: expected.selected === "1" ? expected.second : expected.first,
              large: "Right",
              leading: "Leading",
            });
            await assertPixelsEqual(react, converted.pixels, native.pixels, "React nested handler pixels differ", live);
            if (expected.first === "Ada") await Promise.all([live, react].map((page) => page.locator("button.rename").click()));
          }
          await Promise.all([live, react].map((page) => page.locator("button.missing").click()));
          const [native, converted] = await Promise.all([snapshot(live), snapshot(react)]);
          assert.deepEqual(converted.behavior, native.behavior);
          assert.deepEqual(native.behavior, { first: "Zoe", second: "Ann", selected: "0", count: "2" });
          await Promise.all([live, react].map((page) => page.locator("button.wrong-number").click()));
          const [nativeRejected, convertedRejected] = await Promise.all([snapshot(live), snapshot(react)]);
          assert.deepEqual(convertedRejected.behavior, nativeRejected.behavior);
          assert.deepEqual(nativeRejected.behavior, { first: "Zoe", second: "Ann", selected: "0", count: "2" });
          await Promise.all([live, react].map((page) => page.locator("button.bump").click()));
          const [nativeBumped, convertedBumped] = await Promise.all([snapshot(live), snapshot(react)]);
          assert.deepEqual(convertedBumped.behavior, nativeBumped.behavior, "a rejected scalar write poisoned a later valid write");
          assert.deepEqual(nativeBumped.behavior, { first: "Zoe", second: "Ann", selected: "0", count: "3" });
          await assertPixelsEqual(react, convertedBumped.pixels, nativeBumped.pixels, "React recovered handler pixels differ", live);
          await Promise.all([live, react].map((page) => page.locator("button.wrong-field").click()));
          const [nativeField, convertedField] = await Promise.all([snapshot(live), snapshot(react)]);
          assert.deepEqual(convertedField.behavior, nativeField.behavior, "a rejected nested write changed the field");
          assert.deepEqual(nativeField.behavior, { first: "Zoe", second: "Ann", selected: "0", count: "3" });
          await assertPixelsEqual(react, convertedField.pixels, nativeField.pixels, "React invalid handler pixels differ", live);
          assert.deepEqual(errors, []);
        } finally {
          await live.close(); await react.close(); await browser.close();
        }
      });
    }
  }
});
