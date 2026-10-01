import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";

import { compileScript, parse as parseVue } from "@vue/compiler-sfc";
import { build } from "esbuild";
import { chromium, firefox, webkit, type BrowserType, type Page } from "playwright";

import { convertComponents, type ConversionGraph } from "../src/index.js";

import { assertPixelsEqual, launchParityBrowser } from "../../html-next/tests/pixel-parity.js";

const enabled = process.env.HTMLNEXT_TARGET_TEST === "1";
const nodeModulesPath = new URL("../../html-next/node_modules", import.meta.url).pathname;
const livePath = new URL("../../html-next/src/live.ts", import.meta.url).pathname;
const source = `<template component="x-form-matrix" status="early" summary="Native form model parity."><defs>
  <state type="object({ text: string, checked: boolean, radio: boolean, choice: string, choices: list(string) })" name="form" value="{ text: 'ab', checked: false, radio: false, choice: 'b', choices: ['b'] }"></state>
  <state type="list(unknown)" name="items" value="[{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }]"></state>
  <state type="number" name="ticks" value="0"></state>
  <handler name="unrelated"><set name="ticks" expr:value="ticks + 1"></set></handler>
  <handler name="changeOptions"><set name="items" expr:value="[{ id: 'c', label: 'C' }, { id: 'a', label: 'A' }]"></set></handler>
  <handler name="chooseC"><set name="form.choice" expr:value="'c'"></set><set name="form.choices" expr:value="['c']"></set></handler>
  <handler name="mutateChoices"><set name="form.choices[0]" expr:value="'a'"></set></handler>
</defs><form><input class="text" name="text" required minlength="3" bind:value="form.text">
  <input class="read-only" value="authored" .value="form.text">
  <input class="check" type="checkbox" name="check" bind:checked="form.checked">
  <input class="radio" type="radio" name="radio" value="r" bind:checked="form.radio">
  <select class="single" name="single" bind:value="form.choice"><option $each="item of items" $key="item.id" from:value="item.id" $value="item.label"></option></select>
  <select class="multiple" name="multiple" multiple bind:value="form.choices"><option $each="item of items" $key="item.id" from:value="item.id" $value="item.label"></option></select>
  <button type="button" class="unrelated" on:click="unrelated">Unrelated</button>
  <button type="button" class="options" on:click="changeOptions">Options</button>
  <button type="button" class="choose" on:click="chooseC">Choose C</button>
  <button type="button" class="mutate" on:click="mutateChoices">Mutate choices</button>
  <output class="model" $value="[form.text, form.checked, form.radio, form.choice, form.choices, ticks]"></output>
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
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
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
        single: single.value,
        singleOptions: Array.from(single.options, (option) => [option.value, option.selected]),
        multiple: Array.from(multiple.selectedOptions, (option) => option.value),
        multipleOptions: Array.from(multiple.options, (option) => [option.value, option.selected]),
        data: Array.from(new FormData(form), ([name, value]) => [name, String(value)]),
        model: form.querySelector(".model")!.textContent,
      };
    }),
    pixels: await page.locator("#case").screenshot({ animations: "disabled" }),
  };
}

describe.skipIf(!enabled)("public Vue converter native form model parity", () => {
  let directory = "";
  let liveBundle = "";
  const converted = new Map<ConversionGraph, string>();

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-vue-form-model-"));
    await mkdir(join(directory, "components"));
    await writeFile(join(directory, "components", "matrix.html"), source);
    liveBundle = join(directory, "live.js");
    await build({ entryPoints: [livePath], outfile: liveBundle, bundle: true, format: "iife", globalName: "HtmlRuntime", platform: "browser", target: ["es2022"] });

    for (const mode of ["application", "library"] as const) {
      const outDirectory = join(directory, mode);
      const manifest = await convertComponents({ mode, target: "vue", entries: ["components/matrix.html"], root: directory, outDirectory });
      assert.deepEqual(manifest.components.map((component) => component.tag), ["x-form-matrix"]);
      const file = join(outDirectory, manifest.components[0]!.artifact);
      const parsed = parseVue(await readFile(file, "utf8"), { filename: file });
      assert.deepEqual(parsed.errors, []);
      assert.doesNotMatch(parsed.descriptor.template!.content, /\bv-model(?::|\b)/);
      await writeFile(file.replace(/\.vue$/, ".ts"), compileScript(parsed.descriptor, { id: `form-model-${mode}`, inlineTemplate: true }).content);
      const entry = join(outDirectory, "entry.ts");
      const bundle = join(outDirectory, "vue.js");
      await writeFile(entry, `import { createApp, h } from "vue";
import { XFormMatrix } from "./vue/${mode === "application" ? "application" : "index"}";
createApp({ render: () => h(XFormMatrix, { id: "case" }) }).mount(document.querySelector("main"));\n`);
      await build({
        entryPoints: [entry], outfile: bundle, bundle: true, format: "iife", platform: "browser", target: ["es2022"], nodePaths: [nodeModulesPath],
        plugins: [{ name: "compiled-vue-sfc", setup(pluginBuild) {
          pluginBuild.onResolve({ filter: /\.vue$/ }, (args) => ({ path: resolve(args.resolveDir, args.path.replace(/\.vue$/, ".ts")) }));
        } }],
      });
      converted.set(mode, bundle);
    }
  });

  afterAll(async () => { if (directory !== "") await rm(directory, { recursive: true, force: true }); });

  for (const mode of ["application", "library"] as const) {
    for (const [engine, browserType] of [["Chromium", chromium], ["Firefox", firefox], ["WebKit", webkit]] as const satisfies ReadonlyArray<readonly [string, BrowserType]>) {
      it(`${engine} ${mode} keeps native edits until model changes and resyncs changed options`, async () => {
        const browser = await launchParityBrowser(browserType);
        const [live, vue] = await Promise.all([browser.newPage(), browser.newPage()]);
        const errors: string[] = [];
        try {
          for (const page of [live, vue]) page.on("pageerror", (error) => errors.push(error.message));
          await live.setContent(`${baseStyle}${source}<main><x-form-matrix id="case"></x-form-matrix></main>`);
          await live.addScriptTag({ path: liveBundle });
          await live.evaluate(() => window.HtmlRuntime.lowerDocument());
          await vue.setContent(`${baseStyle}<main></main>`);
          await vue.addScriptTag({ path: converted.get(mode)! });
          const compare = async (stage: string) => {
            const [liveState, vueState] = await Promise.all([snapshot(live), snapshot(vue)]);
            assert.deepEqual(vueState.behavior, liveState.behavior, `${stage} form behavior differs`);
            await assertPixelsEqual(vue, vueState.pixels, liveState.pixels, `${stage} form pixels differ`);
            return liveState.behavior as { readonly text: string; readonly single: string; readonly multiple: readonly string[]; readonly tooShort: boolean };
          };
          const initial = await compare("initial");
          assert.equal(initial.single, "b");
          assert.deepEqual(initial.multiple, ["b"]);

          for (const page of [live, vue]) await page.evaluate(() => {
            const form = document.querySelector<HTMLFormElement>("#case")!;
            form.querySelector<HTMLInputElement>(".text")!.value = "xy";
            form.querySelector<HTMLInputElement>(".check")!.checked = true;
            form.querySelector<HTMLInputElement>(".radio")!.checked = true;
            form.querySelector<HTMLSelectElement>(".single")!.value = "a";
            const multiple = form.querySelector<HTMLSelectElement>(".multiple")!;
            multiple.options[0]!.selected = true;
            multiple.options[1]!.selected = false;
          });
          await Promise.all([live, vue].map((page) => page.locator("#case .unrelated").click()));
          const untouched = await compare("unrelated render after native edits");
          assert.equal(untouched.text, "xy");
          assert.equal(untouched.single, "a");
          assert.deepEqual(untouched.multiple, ["a"]);

          for (const page of [live, vue]) await page.evaluate(() => {
            const form = document.querySelector<HTMLFormElement>("#case")!;
            form.querySelector<HTMLInputElement>(".text")!.dispatchEvent(new Event("input", { bubbles: true }));
            form.querySelector<HTMLInputElement>(".check")!.dispatchEvent(new Event("change", { bubbles: true }));
            form.querySelector<HTMLInputElement>(".radio")!.dispatchEvent(new Event("change", { bubbles: true }));
            form.querySelector<HTMLSelectElement>(".single")!.dispatchEvent(new Event("change", { bubbles: true }));
            form.querySelector<HTMLSelectElement>(".multiple")!.dispatchEvent(new Event("change", { bubbles: true }));
          });
          await compare("native change events update the model");
          await Promise.all([live, vue].map((page) => page.locator("#case .options").click()));
          const changedOptions = await compare("reactive option replacement");
          assert.equal(changedOptions.single, "a");
          assert.deepEqual(changedOptions.multiple, ["a"]);
          await Promise.all([live, vue].map((page) => page.locator("#case .choose").click()));
          const modelUpdate = await compare("model change retakes selection");
          assert.equal(modelUpdate.single, "c");
          assert.deepEqual(modelUpdate.multiple, ["c"]);
          await Promise.all([live, vue].map((page) => page.locator("#case .mutate").click()));
          const mutatedModel = await compare("in-place multiple-select model change");
          assert.deepEqual(mutatedModel.multiple, ["a"]);

          for (const page of [live, vue]) await page.evaluate(() => document.querySelector<HTMLFormElement>("#case")!.reset());
          const reset = await compare("native form reset after model changes");
          assert.equal(reset.text, "");
          assert.equal(reset.single, "c");
          assert.deepEqual(reset.multiple, []);
          await Promise.all([live, vue].map((page) => page.locator("#case .unrelated").click()));
          await compare("unrelated render after native form reset");
          assert.deepEqual(errors, []);
        } finally {
          await Promise.all([live.close(), vue.close()]);
          await browser.close();
        }
      });
    }
  }
});

declare global {
  interface Window { HtmlRuntime: { lowerDocument(): void } }
}
