import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, it } from "vitest";

import { build } from "esbuild";
import { createElement, type ComponentType } from "react";
import { renderToString } from "react-dom/server";
import { chromium, firefox, webkit, type BrowserType, type Page } from "playwright";

import { assertPixelsEqual, launchParityBrowser } from "../../html-next/tests/pixel-parity.js";
import { convertComponents, type ConversionGraph } from "../src/index.js";

const enabled = process.env.HTMLNEXT_TARGET_TEST === "1";
const nodeModulesPath = fileURLToPath(new URL("../node_modules", import.meta.url));
const livePath = fileURLToPath(new URL("../../html-next/src/live.ts", import.meta.url));
const source = `<template component="x-form-matrix" status="early" summary="Native form model parity."><defs>
  <state type="object({ text: string, checked: boolean, radio: boolean, choice: string, choices: list(string) })" name="form" value="{ text: 'ab', checked: false, radio: false, choice: 'b', choices: ['b'] }"></state>
  <state type="list(unknown)" name="items" value="[{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }]"></state>
  <state type="number" name="ticks" value="0"></state>
  <state type="boolean" name="showLate" value="false"></state>
  <handler name="unrelated"><set name="ticks" expr:value="$ticks + 1"></set></handler>
  <handler name="addLate"><set name="showLate" expr:value="true"></set></handler>
  <handler name="changeOptions"><set name="items" expr:value="[{ id: 'c', label: 'C' }, { id: 'a', label: 'A' }]"></set></handler>
  <handler name="relabelOptions"><set name="items" expr:value="[{ id: 'c', label: 'CC' }, { id: 'a', label: 'AA' }]"></set></handler>
  <handler name="chooseC"><set name="form.choice" expr:value="'c'"></set><set name="form.choices" expr:value="['c']"></set></handler>
  <handler name="mutateChoices"><set name="form.choices.0" expr:value="'a'"></set></handler>
</defs><form><input class="text" name="text" required minlength="3" bind:value="form.text">
  <input class="read-only" value="authored" .value="$form.text">
  <input class="check" type="checkbox" name="check" bind:checked="form.checked">
  <input class="radio" type="radio" name="radio" value="r" bind:checked="form.radio">
  <input $if="$showLate" class="late" bind:value="form.text">
  <select class="single" name="single" bind:value="form.choice"><option $each="item of $items" $key="$item.id" from:value="$item.id" $value="$item.label"></option></select>
  <select class="multiple" name="multiple" multiple bind:value="form.choices"><option $each="item of $items" $key="$item.id" from:value="$item.id" $value="$item.label"></option></select>
  <button type="button" class="unrelated" on:click="unrelated">Unrelated</button>
  <button type="button" class="add-late" on:click="addLate">Add</button>
  <button type="button" class="options" on:click="changeOptions">Options</button>
  <button type="button" class="relabel" on:click="relabelOptions">Relabel</button>
  <button type="button" class="choose" on:click="chooseC">Choose C</button>
  <button type="button" class="mutate" on:click="mutateChoices">Mutate choices</button>
  <output class="model" $value="[$form.text, $form.checked, $form.radio, $form.choice, $form.choices, $ticks]"></output>
  <output class="typed" $value="$form.text"></output>
  <output class="row-output" $each="item of $items" $key="$item.id" $value="$item.label"></output>
</form></template>`;
const baseStyle = `<style>
  html { color-scheme: light; }
  body { margin: 8px; font: 16px/1.4 Arial, sans-serif; }
  input, textarea, select, button { appearance: none; box-sizing: border-box; font: inherit; color: #111; background: #fff; border: 1px solid #888; border-radius: 0; }
  input, textarea { caret-color: transparent; }
  input[type=checkbox], input[type=radio] { width: 14px; height: 14px; vertical-align: middle; }
  input[type=checkbox]:checked, input[type=radio]:checked { background: #333; }
  button { background: #eee; }
</style>`;

async function snapshot(page: Page): Promise<{ readonly behavior: unknown; readonly pixels: Buffer }> {
  await page.mouse.move(0, 0);
  await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); });
  await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
  return {
    behavior: await page.evaluate(() => {
      const form = document.querySelector<HTMLFormElement>("#case")!;
      const text = form.querySelector<HTMLInputElement>(".text")!;
      const readOnly = form.querySelector<HTMLInputElement>(".read-only")!;
      const check = form.querySelector<HTMLInputElement>(".check")!;
      const radio = form.querySelector<HTMLInputElement>(".radio")!;
      const single = form.querySelector<HTMLSelectElement>(".single")!;
      const multiple = form.querySelector<HTMLSelectElement>(".multiple")!;
      return {
        root: form.localName,
        text: text.value,
        readOnly: [readOnly.value, readOnly.defaultValue],
        tooShort: text.validity.tooShort,
        checked: check.checked,
        radio: radio.checked,
        late: form.querySelector<HTMLInputElement>(".late")?.value ?? null,
        single: single.value,
        singleOptions: Array.from(single.options, (option) => [option.value, option.selected]),
        multiple: Array.from(multiple.selectedOptions, (option) => option.value),
        multipleOptions: Array.from(multiple.options, (option) => [option.value, option.selected]),
        data: Array.from(new FormData(form), ([name, value]) => [name, String(value)]),
        model: form.querySelector(".model")!.textContent,
        typed: form.querySelector(".typed")!.textContent,
        rows: Array.from(form.querySelectorAll(".row-output"), (output) => output.textContent),
      };
    }),
    pixels: await page.locator("#case").screenshot({ animations: "disabled" }),
  };
}

describe.skipIf(!enabled)("public React converter native form model parity", () => {
  let directory = "";
  let liveBundle = "";
  const converted = new Map<ConversionGraph, { readonly bundle: string; readonly markup: string }>();

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-react-form-model-"));
    await mkdir(join(directory, "components"));
    await writeFile(join(directory, "components", "matrix.html"), source);
    liveBundle = join(directory, "live.js");
    await build({ entryPoints: [livePath], outfile: liveBundle, bundle: true, format: "iife", globalName: "HtmlRuntime", platform: "browser", target: ["es2022"] });
    for (const mode of ["application", "library"] as const) {
      const outDirectory = join(directory, mode);
      const manifest = await convertComponents({ mode, target: "react", entries: ["components/matrix.html"], root: directory, outDirectory });
      assert.deepEqual(manifest.components.map((component) => component.tag), ["x-form-matrix"]);
      const entry = join(outDirectory, "entry.tsx");
      const client = join(outDirectory, "react.js");
      await writeFile(entry, `import React from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import { XFormMatrix } from "./react/${mode === "application" ? "application" : "index"}";
const main = document.querySelector("main")!;
const tree = <XFormMatrix id="case" />;
(window as any).recoverableErrors = [];
if (main.hasChildNodes()) hydrateRoot(main, tree, { onRecoverableError(error) {
  (window as any).recoverableErrors.push(error.message);
} });
else createRoot(main).render(tree);
`);
      await build({ entryPoints: [entry], outfile: client, bundle: true, format: "iife", platform: "browser",
        target: ["es2022"], jsx: "automatic", loader: { ".css": "empty" }, nodePaths: [nodeModulesPath] });
      const server = await build({ entryPoints: [join(outDirectory, manifest.output.entry)], bundle: true, write: false,
        platform: "node", format: "cjs", jsx: "automatic", packages: "external", loader: { ".css": "empty" } });
      const module = { exports: {} as Record<string, ComponentType<Record<string, unknown>>> };
      new Function("require", "module", "exports", server.outputFiles[0]!.text)(createRequire(import.meta.url), module, module.exports);
      converted.set(mode, { bundle: client, markup: renderToString(createElement(module.exports.XFormMatrix!, { id: "case" })) });
    }
  });

  afterAll(async () => { if (directory !== "") await rm(directory, { recursive: true, force: true }); });

  for (const mode of ["application", "library"] as const) {
    for (const [engine, browserType] of [["Chromium", chromium], ["Firefox", firefox], ["WebKit", webkit]] as const satisfies ReadonlyArray<readonly [string, BrowserType]>) {
      for (const hydrate of [false, true]) {
      it(`${engine} ${mode} ${hydrate ? "hydration" : "mount"} keeps native edits until model changes and resyncs changed options`, async () => {
        const browser = await launchParityBrowser(browserType);
        const [live, react] = await Promise.all([browser.newPage(), browser.newPage()]);
        const errors: string[] = [];
        try {
          for (const page of [live, react]) page.on("pageerror", (error) => errors.push(error.message));
          await live.setContent(`${baseStyle}${source}<main><x-form-matrix id="case"></x-form-matrix></main>`);
          await live.addScriptTag({ path: liveBundle });
          await live.evaluate(() => window.HtmlRuntime.lowerDocument());
          await react.setContent(`${baseStyle}<main>${hydrate ? converted.get(mode)!.markup : ""}</main>`);
          await react.addScriptTag({ path: converted.get(mode)!.bundle });
          await react.locator("#case .single").waitFor();
          const compare = async (stage: string) => {
            const [native, convertedReact] = await Promise.all([snapshot(live), snapshot(react)]);
            assert.deepEqual(convertedReact.behavior, native.behavior, `${stage} form behavior differs`);
            await assertPixelsEqual(react, convertedReact.pixels, native.pixels, `${stage} form pixels differ`, live);
            return native.behavior as { readonly text: string; readonly single: string; readonly multiple: readonly string[]; readonly tooShort: boolean; readonly late: string | null; readonly typed: string; readonly rows: readonly string[] };
          };
          const initial = await compare("initial");
          assert.equal(initial.single, "b");
          assert.deepEqual(initial.multiple, ["b"]);
          assert.equal(initial.typed, "ab");
          assert.deepEqual(initial.rows, ["A", "B"]);

          for (const page of [live, react]) await page.evaluate(() => {
            const form = document.querySelector<HTMLFormElement>("#case")!;
            form.querySelector<HTMLInputElement>(".text")!.value = "xy";
            form.querySelector<HTMLInputElement>(".check")!.checked = true;
            form.querySelector<HTMLInputElement>(".radio")!.checked = true;
            form.querySelector<HTMLSelectElement>(".single")!.value = "a";
            const multiple = form.querySelector<HTMLSelectElement>(".multiple")!;
            multiple.options[0]!.selected = true;
            multiple.options[1]!.selected = false;
          });
          await Promise.all([live, react].map((page) => page.locator("#case .unrelated").click()));
          const untouched = await compare("unrelated render after native edits");
          assert.equal(untouched.text, "xy");
          assert.equal(untouched.single, "a");
          assert.deepEqual(untouched.multiple, ["a"]);

          for (const page of [live, react]) await page.evaluate(() => {
            const form = document.querySelector<HTMLFormElement>("#case")!;
            form.querySelector<HTMLInputElement>(".text")!.dispatchEvent(new Event("input", { bubbles: true }));
            form.querySelector<HTMLInputElement>(".check")!.dispatchEvent(new Event("change", { bubbles: true }));
            form.querySelector<HTMLInputElement>(".radio")!.dispatchEvent(new Event("change", { bubbles: true }));
            form.querySelector<HTMLSelectElement>(".single")!.dispatchEvent(new Event("change", { bubbles: true }));
            form.querySelector<HTMLSelectElement>(".multiple")!.dispatchEvent(new Event("change", { bubbles: true }));
          });
          await compare("native change events update the model");
          await Promise.all([live, react].map((page) => page.locator("#case .add-late").click()));
          const late = await compare("native control inserted after mount");
          assert.equal(late.late, "xy");
          await Promise.all([live, react].map((page) => page.locator("#case .options").click()));
          const changedOptions = await compare("reactive option replacement");
          assert.equal(changedOptions.single, "a");
          assert.deepEqual(changedOptions.multiple, ["a"]);
          await Promise.all([live, react].map((page) => page.locator("#case .relabel").click()));
          const relabeledOptions = await compare("row-scoped output update");
          assert.deepEqual(relabeledOptions.rows, ["CC", "AA"]);
          await Promise.all([live, react].map((page) => page.locator("#case .choose").click()));
          const modelUpdate = await compare("model change retakes selection");
          assert.equal(modelUpdate.single, "c");
          assert.deepEqual(modelUpdate.multiple, ["c"]);
          await Promise.all([live, react].map((page) => page.locator("#case .mutate").click()));
          const mutatedModel = await compare("in-place multiple-select model change");
          assert.deepEqual(mutatedModel.multiple, ["a"]);

          for (const page of [live, react]) await page.evaluate(() => document.querySelector<HTMLFormElement>("#case")!.reset());
          const reset = await compare("native form reset after model changes");
          assert.equal(reset.text, "");
          assert.equal(reset.typed, "xy");
          assert.equal(reset.single, "c");
          assert.deepEqual(reset.multiple, []);
          await Promise.all([live, react].map((page) => page.locator("#case .unrelated").click()));
          await Promise.all([live, react].map((page) => page.waitForFunction(() =>
            document.querySelector("#case .model")?.textContent?.endsWith(" 2"), undefined, { timeout: 1000 })));
          await compare("unrelated render after native form reset");
          assert.deepEqual(errors, []);
        } finally {
          await Promise.all([live.close(), react.close()]);
          await browser.close();
        }
      });
      }
      it(`${engine} ${mode} leaves incompatible hydration diagnostics with React`, async () => {
        const browser = await launchParityBrowser(browserType);
        const [page, fresh] = await Promise.all([browser.newPage(), browser.newPage()]);
        const errors: string[] = [];
        try {
          for (const current of [page, fresh]) current.on("pageerror", (error) => errors.push(error.message));
          await page.setContent(`${baseStyle}<main><article id="case">Incompatible server root</article></main>`);
          await fresh.setContent(`${baseStyle}<main></main>`);
          await page.addScriptTag({ path: converted.get(mode)!.bundle });
          await fresh.addScriptTag({ path: converted.get(mode)!.bundle });
          await page.locator("#case .text").waitFor();
          await fresh.locator("#case .text").waitFor();
          const recovery = await page.evaluate(() => (window as unknown as { recoverableErrors: string[] }).recoverableErrors);
          assert.ok(recovery.length > 0, "React should report the incompatible root through onRecoverableError");
          assert.ok(recovery.every((message) => !message.includes("HR005")), JSON.stringify(recovery));
          const [recovered, mounted] = await Promise.all([snapshot(page), snapshot(fresh)]);
          assert.deepEqual(recovered.behavior, mounted.behavior, "React recovery must render the normal component state");
          await assertPixelsEqual(page, recovered.pixels, mounted.pixels, "React recovery pixels differ from a fresh mount", fresh);
          assert.deepEqual(errors, []);
        } finally {
          await Promise.all([page.close(), fresh.close()]);
          await browser.close();
        }
      });
    }
  }
});

declare global {
  interface Window { HtmlRuntime: { lowerDocument(): void } }
}
