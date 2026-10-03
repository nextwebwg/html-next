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
const source = `<template component="x-controls" status="early" summary="Control parity."><defs>
  <state type="object" name="form" value="{ name: 'Ada', checked: false, choice: 'a', count: 1, tags: ['a'], note: 'Ready' }"></state>
  <state type="object" name="readOnly" value="{ text: 'Hold', checked: false, choice: 'a', note: 'Keep' }"></state>
  <state type="number" name="tick" value="0"></state>
  <handler name="bump"><set name="tick" expr:value="tick + 1"></set></handler>
  <handler name="changeReadOnly"><set name="readOnly" expr:value="{ text: 'Next', checked: true, choice: 'b', note: 'Later' }"></set></handler>
</defs><form><label>Name <input class="text" name="name" value="Seed" bind:value="form.name"></label>
  <label>Ready <input class="check" type="checkbox" name="ready" checked bind:checked="form.checked"></label>
  <select class="choice" name="choice" bind:value="form.choice"><option value="a">A</option><option value="b" selected>B</option></select>
  <input class="number" type="number" name="count" value="3" bind:value="form.count">
  <select class="tags" name="tags" multiple bind:value="form.tags"><option value="a">A</option><option value="b" selected>B</option></select>
  <textarea class="note" name="note" bind:value="form.note">Draft</textarea>
  <div class="properties"><input class="read-only-text" value="Authored" .value="readOnly.text">
    <input class="read-only-check" type="checkbox" checked .checked="readOnly.checked">
    <select class="read-only-choice" .value="readOnly.choice"><option value="a">A</option><option value="b" selected>B</option></select>
    <select class="read-only-multiple" multiple .value="readOnly.choice"><option value="a">A</option><option value="b" selected>B</option></select>
    <textarea class="read-only-note" .value="readOnly.note">Authored note</textarea></div>
  <output $value="[form.name, form.checked, form.choice, form.count, form.tags, form.note, tick]"></output>
  <button class="bump" type="button" on:click="bump">Bump</button>
  <button class="change-read-only" type="button" on:click="changeReadOnly">Change</button>
</form><style>:host { display: block; padding: 8px; background: rgb(240, 245, 250); }
  input.number, select.tags { border: 1px solid rgb(100, 100, 100); border-radius: 0; }</style></template>`;

async function snapshot(page: Page): Promise<{
  readonly values: readonly [string, boolean, string, string, readonly string[], string];
  readonly propertyValues: readonly [string, boolean, string, readonly string[], string];
  readonly output: string;
  readonly pixels: Buffer;
}> {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  return {
    values: await page.locator("form").evaluate((form) => [
      (form.querySelector(".text") as HTMLInputElement).value,
      (form.querySelector(".check") as HTMLInputElement).checked,
      (form.querySelector(".choice") as HTMLSelectElement).value,
      (form.querySelector(".number") as HTMLInputElement).value,
      Array.from((form.querySelector(".tags") as HTMLSelectElement).selectedOptions, (option) => option.value),
      (form.querySelector(".note") as HTMLTextAreaElement).value,
    ] as const),
    propertyValues: await page.locator("form").evaluate((form) => [
      (form.querySelector(".read-only-text") as HTMLInputElement).value,
      (form.querySelector(".read-only-check") as HTMLInputElement).checked,
      (form.querySelector(".read-only-choice") as HTMLSelectElement).value,
      Array.from((form.querySelector(".read-only-multiple") as HTMLSelectElement).selectedOptions, (option) => option.value),
      (form.querySelector(".read-only-note") as HTMLTextAreaElement).value,
    ] as const),
    output: await page.locator("output").innerText(),
    pixels: await page.locator("form").screenshot({ animations: "disabled" }),
  };
}

describe.skipIf(!enabled)("React native control and hydration parity", () => {
  let directory = "";
  let liveBundle = "";
  let mountBundle = "";
  let hydrateBundle = "";
  let serverMarkup = "";
  let css = "";

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-react-controls-"));
    await writeFile(join(directory, "controls.html"), source);
    const outDirectory = join(directory, "out");
    const manifest = await convertComponents({ mode: "application", target: "react", root: directory, outDirectory, entries: ["controls.html"] });
    const style = manifest.output.artifacts.find((artifact) => artifact.kind === "style");
    css = style === undefined ? "" : await readFile(join(outDirectory, style.path), "utf8");
    const reactEntry = join(outDirectory, "mount.tsx");
    await writeFile(reactEntry, `import React from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import { XControls } from "./react/application";
const main = document.querySelector("main")!;
if (main.hasChildNodes()) hydrateRoot(main, <XControls />);
else createRoot(main).render(<XControls />);`);
    mountBundle = join(outDirectory, "mount.js");
    hydrateBundle = mountBundle;
    await build({
      entryPoints: [reactEntry], outfile: mountBundle, bundle: true, format: "iife", platform: "browser",
      target: ["es2022"], jsx: "automatic", loader: { ".css": "empty" },
      nodePaths: [fileURLToPath(new URL("../node_modules", import.meta.url))],
    });
    const server = await build({
      entryPoints: [join(outDirectory, manifest.output.entry)], bundle: true, write: false,
      platform: "node", format: "cjs", jsx: "automatic", packages: "external", loader: { ".css": "empty" },
    });
    const module = { exports: {} as Record<string, ComponentType<Record<string, unknown>>> };
    new Function("require", "module", "exports", server.outputFiles[0]!.text)(createRequire(import.meta.url), module, module.exports);
    serverMarkup = renderToString(createElement(module.exports.XControls!));
    liveBundle = join(directory, "live.js");
    await build({
      entryPoints: [fileURLToPath(new URL("../../html-next/src/live.ts", import.meta.url))],
      outfile: liveBundle, bundle: true, format: "iife", globalName: "HtmlRuntime", platform: "browser", target: ["es2022"],
    });
  });

  afterAll(async () => { if (directory !== "") await rm(directory, { recursive: true, force: true }); });

  for (const [engine, browserType] of [["Chromium", chromium], ["Firefox", firefox], ["WebKit", webkit]] as const satisfies ReadonlyArray<readonly [string, BrowserType]>) {
    it(`${engine} matches native edits and later state updates`, async () => {
      const browser = await launchParityBrowser(browserType);
      const live = await browser.newPage();
      const react = await browser.newPage();
      const errors: string[] = [];
      try {
        for (const page of [live, react]) page.on("pageerror", (error) => errors.push(error.message));
        await live.setContent(`${source}<main><x-controls></x-controls></main>`);
        await live.addScriptTag({ path: liveBundle });
        await live.evaluate(() => window.HtmlRuntime.lowerDocument());
        await react.setContent(`<style>${css}</style><main></main>`);
        await react.addScriptTag({ path: mountBundle });
        await Promise.all([live, react].map((page) => page.locator("form .text").waitFor()));
        const [nativeInitial, convertedInitial] = await Promise.all([snapshot(live), snapshot(react)]);
        assert.deepEqual(convertedInitial.values, nativeInitial.values);
        assert.deepEqual(convertedInitial.propertyValues, nativeInitial.propertyValues);
        assert.deepEqual(nativeInitial.propertyValues, ["Hold", false, "a", ["a"], "Keep"]);
        assert.equal(convertedInitial.output, nativeInitial.output);
        for (const page of [live, react]) {
          await page.locator(".text").evaluate((input: HTMLInputElement) => { input.value = "Grace"; input.dispatchEvent(new Event("input", { bubbles: true })); });
          await page.locator(".check").evaluate((input: HTMLInputElement) => { input.checked = true; input.dispatchEvent(new Event("change", { bubbles: true })); });
          await page.locator(".choice").evaluate((select: HTMLSelectElement) => { select.value = "b"; select.dispatchEvent(new Event("change", { bubbles: true })); });
          await page.locator(".number").evaluate((input: HTMLInputElement) => { input.value = "7"; input.dispatchEvent(new Event("input", { bubbles: true })); });
          await page.locator(".tags").evaluate((select: HTMLSelectElement) => { select.options[1]!.selected = true; select.dispatchEvent(new Event("change", { bubbles: true })); });
          await page.locator(".note").evaluate((textarea: HTMLTextAreaElement) => { textarea.value = "Edited"; textarea.dispatchEvent(new Event("input", { bubbles: true })); });
          await page.locator(".read-only-text").evaluate((input: HTMLInputElement) => { input.value = "Local"; input.dispatchEvent(new Event("input", { bubbles: true })); });
          await page.locator(".read-only-check").evaluate((input: HTMLInputElement) => { input.checked = true; input.dispatchEvent(new Event("change", { bubbles: true })); });
          await page.locator(".read-only-choice").evaluate((select: HTMLSelectElement) => { select.value = "b"; select.dispatchEvent(new Event("change", { bubbles: true })); });
          await page.locator(".read-only-multiple").evaluate((select: HTMLSelectElement) => { select.value = "b"; select.dispatchEvent(new Event("change", { bubbles: true })); });
          await page.locator(".read-only-note").evaluate((textarea: HTMLTextAreaElement) => { textarea.value = "Unsent"; textarea.dispatchEvent(new Event("input", { bubbles: true })); });
        }
        await Promise.all([live, react].map((page) => page.locator("button.bump").click()));
        const [native, converted] = await Promise.all([snapshot(live), snapshot(react)]);
        assert.deepEqual(converted.values, native.values);
        assert.deepEqual(converted.propertyValues, native.propertyValues);
        assert.deepEqual(native.propertyValues, ["Local", true, "b", ["b"], "Unsent"]);
        assert.equal(converted.output, native.output);
        // Chromium can rasterize two native-control pixels one channel apart across these pages.
        await assertPixelsEqual(react, converted.pixels, native.pixels, "React controls pixels differ", live,
          engine === "Chromium" ? { maxChangedPixels: 2, maxChannelDelta: 1 } : undefined);
        await Promise.all([live, react].map((page) => page.locator("form").evaluate((form: HTMLFormElement) => form.reset())));
        const [nativeReset, convertedReset] = await Promise.all([snapshot(live), snapshot(react)]);
        assert.deepEqual(nativeReset.values, ["Seed", true, "b", "3", ["b"], "Draft"]);
        assert.deepEqual(convertedReset.values, nativeReset.values, "form reset must use authored defaults, not bound live values");
        assert.deepEqual(nativeReset.propertyValues, ["Authored", true, "b", ["b"], "Authored note"]);
        assert.deepEqual(convertedReset.propertyValues, nativeReset.propertyValues);
        assert.equal(convertedReset.output, nativeReset.output);
        await Promise.all([live, react].map((page) => page.locator("button.change-read-only").click()));
        const [nativeChanged, convertedChanged] = await Promise.all([snapshot(live), snapshot(react)]);
        assert.deepEqual(nativeChanged.propertyValues, ["Next", true, "b", ["b"], "Later"]);
        assert.deepEqual(convertedChanged.propertyValues, nativeChanged.propertyValues);
        assert.deepEqual(errors, []);
      } finally {
        await live.close(); await react.close(); await browser.close();
      }
    });

    it(`${engine} retains pre-hydration native edits through unrelated updates`, async () => {
      const browser = await launchParityBrowser(browserType);
      const page = await browser.newPage();
      const errors: string[] = [];
      try {
        page.on("pageerror", (error) => errors.push(error.message));
        await page.setContent(`<style>${css}</style><main>${serverMarkup}</main>`);
        await page.locator(".text").evaluate((input: HTMLInputElement) => { input.value = "Grace"; });
        await page.locator(".check").evaluate((input: HTMLInputElement) => { input.checked = true; });
        await page.locator(".choice").evaluate((select: HTMLSelectElement) => { select.value = "b"; });
        await page.locator(".number").evaluate((input: HTMLInputElement) => { input.value = "7"; });
        await page.locator(".tags").evaluate((select: HTMLSelectElement) => { select.options[1]!.selected = true; });
        await page.locator(".note").evaluate((textarea: HTMLTextAreaElement) => { textarea.value = "Unsent"; });
        await page.locator(".read-only-text").evaluate((input: HTMLInputElement) => { input.value = "Local"; });
        await page.locator(".read-only-check").evaluate((input: HTMLInputElement) => { input.checked = true; });
        await page.locator(".read-only-choice").evaluate((select: HTMLSelectElement) => { select.value = "b"; });
        await page.locator(".read-only-multiple").evaluate((select: HTMLSelectElement) => { select.value = "b"; });
        await page.locator(".read-only-note").evaluate((textarea: HTMLTextAreaElement) => { textarea.value = "Unsent"; });
        await page.addScriptTag({ path: hydrateBundle });
        await page.waitForFunction(() => document.querySelector("form")?.getAttribute("data-component") === "x-controls");
        const hydrated = await snapshot(page);
        assert.equal(hydrated.values[5], "Unsent", "hydration must preserve textarea's pre-hydration edit");
        assert.deepEqual(hydrated.propertyValues, ["Local", true, "b", ["b"], "Unsent"]);
        await page.locator("button.bump").click();
        const result = await snapshot(page);
        assert.deepEqual(result.values, ["Grace", true, "b", "7", ["a", "b"], "Unsent"]);
        assert.deepEqual(result.propertyValues, ["Local", true, "b", ["b"], "Unsent"]);
        assert.equal(result.output, "Ada false a 1 a Ready 1");
        await page.locator("button.change-read-only").click();
        assert.deepEqual((await snapshot(page)).propertyValues, ["Next", true, "b", ["b"], "Later"]);
        assert.deepEqual(errors, []);
      } finally {
        await page.close(); await browser.close();
      }
    });
  }
});
