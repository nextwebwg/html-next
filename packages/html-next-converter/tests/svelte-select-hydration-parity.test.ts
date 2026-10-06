import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, it } from "vitest";
import { build } from "esbuild";
import { chromium, firefox, webkit, type Page } from "playwright";
import { convertComponents } from "../src/index.js";
import { sveltePlugin } from "./helpers/svelte.js";

const enabled = process.env.HTMLNEXT_TARGET_TEST === "1";
const sources = {
  late: `<template component="x-picker" status="early" summary="Late control hydration."><defs>
    <state name="value" type="string" value="Second"></state><state name="checked" type="boolean" value="false"></state>
    </defs><form><input value="Draft" bind:value="value"><textarea bind:value="value">Draft</textarea>
      <input type="checkbox" checked bind:checked="checked"><select bind:value="value"><option selected>First</option><option>Second</option></select></form></template>`,
  siblings: `<template component="x-field" status="early" summary="Sibling controls."><defs>
    <prop name="value" type="string" default="Second">Value.</prop><prop name="checked" type="boolean" default="false">Checked.</prop>
    </defs><article><input value="Draft" .value="value"><textarea .value="value">Draft</textarea>
      <input type="checkbox" checked .checked="checked"><select .value="value"><option selected>First</option><option>Second</option></select></article></template>
    <template component="x-picker" status="early" summary="Sibling control owner."><form><x-field></x-field><x-field></x-field><x-field></x-field></form></template>`,
  rich: `<template component="x-picker" status="early" summary="Explicit rich option values."><defs>
    <state name="value" type="string" value="Same"></state></defs><form><select bind:value="value">
      <option value="Same" selected><span>First</span></option><option value="Same"><b>Second</b></option></select></form></template>`,
};

async function snapshot(page: Page) {
  return page.evaluate(() => {
    const select = document.querySelector("select")!;
    return {
      value: select.value, index: select.selectedIndex,
      selected: Array.from(select.options, (option) => option.selected),
      defaults: Array.from(select.options, (option) => option.defaultSelected),
      markers: document.querySelectorAll("[data-html-next-option-default]").length,
      text: document.querySelector("input")?.value,
      textDefault: document.querySelector("input")?.defaultValue,
      area: document.querySelector("textarea")?.value,
      areaDefault: document.querySelector("textarea")?.defaultValue,
      checked: document.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked,
      checkedDefault: document.querySelector<HTMLInputElement>('input[type="checkbox"]')?.defaultChecked,
      controls: Array.from(document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("input, textarea, select"), (control) => ({
        tag: control.localName, value: control.value,
        defaults: control instanceof HTMLSelectElement ? Array.from(control.options, (option) => option.defaultSelected) : control.defaultValue,
        checked: control instanceof HTMLInputElement ? control.checked : undefined,
        checkedDefault: control instanceof HTMLInputElement ? control.defaultChecked : undefined,
      })),
    };
  });
}

async function edit(page: Page) {
  await page.evaluate(() => {
    document.querySelector("select")!.value = "First";
    document.querySelector("input")!.value = "Edited";
    document.querySelector("textarea")!.value = "Edited";
    document.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked = true;
  });
}

describe.skipIf(!enabled)("Svelte select hydration parity", () => {
  let directory = "";
  let live = "";
  const outputs = new Map<string, { bundle: string; markup: string }>();
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-select-hydration-"));
    await symlink(fileURLToPath(new URL("../node_modules", import.meta.url)), join(directory, "node_modules"), "dir");
    live = join(directory, "live.js");
    await build({ entryPoints: [fileURLToPath(new URL("../../html-next/src/live.ts", import.meta.url))], outfile: live,
      bundle: true, format: "iife", globalName: "Live", platform: "browser" });
    for (const [fixture, source] of Object.entries(sources)) {
      await writeFile(join(directory, `${fixture}.html`), source);
      for (const mode of ["application", "library"] as const) {
        const outDirectory = join(directory, `${fixture}-${mode}`);
        const manifest = await convertComponents({ target: "svelte", mode, root: directory, outDirectory, entries: [`${fixture}.html`] });
        const artifact = manifest.components.find((component) => component.tag === "x-picker")!.artifact;
        await writeFile(join(outDirectory, "client.ts"), `import { hydrate, flushSync } from "svelte";
import Picker from "./${artifact}";
(window as any).hydratePicker = (target = document.querySelector("main")!, settle = true) => { hydrate(Picker, { target }); if (settle) flushSync(); };
(window as any).finishHydration = flushSync;`);
        const bundle = join(outDirectory, "client.js");
        await build({ entryPoints: [join(outDirectory, "client.ts")], outfile: bundle, bundle: true, format: "iife",
          platform: "browser", loader: { ".css": "empty" }, plugins: [sveltePlugin("client")] });
        await writeFile(join(outDirectory, "server.ts"), `import { render } from "svelte/server";
import Picker from "./${artifact}"; export const markup = render(Picker).body;`);
        const server = join(outDirectory, "server.mjs");
        await build({ entryPoints: [join(outDirectory, "server.ts")], outfile: server, bundle: true, format: "esm",
          platform: "node", packages: "external", loader: { ".css": "empty" }, plugins: [sveltePlugin("server")] });
        const { markup } = await import(pathToFileURL(server).href) as { markup: string };
        outputs.set(`${fixture}-${mode}`, { bundle, markup });
      }
    }
  }, 60_000);
  afterAll(async () => { if (directory !== "") await rm(directory, { recursive: true, force: true }); });

  for (const [engine, type] of [["Chromium", chromium], ["Firefox", firefox], ["WebKit", webkit]] as const) {
    for (const mode of ["application", "library"] as const) {
      for (const timing of ["same batch", "later edit"] as const) {
        it(`${engine} ${mode} ${timing} keeps independent hydration root snapshots`, async () => {
          const browser = await type.launch();
          const pages = await Promise.all([browser.newPage(), browser.newPage()]);
          const [native, converted] = pages as [Page, Page];
          const errors: string[] = [];
          const warnings: string[] = [];
          converted.on("console", (message) => { if (message.type() === "warning") warnings.push(message.text()); });
          for (const page of pages) page.on("pageerror", (error) => errors.push(error.message));
          try {
            const output = outputs.get(`late-${mode}`)!;
            await native.setContent(`<main>${sources.late}<section data-first><x-picker></x-picker></section><section data-second><x-picker></x-picker></section></main>`);
            await native.addScriptTag({ path: live });
            await native.evaluate(() => (window as unknown as { Live: { lowerDocument(): void } }).Live.lowerDocument());
            await converted.setContent("<main></main>");
            await converted.addScriptTag({ path: output.bundle });
            await converted.locator("main").evaluate((main, markup) => {
              main.innerHTML = `<section data-first>${markup}</section><section data-second>${markup}</section>`;
            }, output.markup);
            const editSecond = () => {
              const root = document.querySelector("[data-second]")!;
              root.querySelector("input")!.value = "Later";
              root.querySelector("textarea")!.value = "Later";
              root.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked = true;
              root.querySelector("select")!.value = "First";
            };
            if (timing === "later edit") await native.evaluate(editSecond);
            await converted.evaluate(async (later) => {
              const api = window as unknown as { hydratePicker(target: Element, settle: boolean): void; finishHydration(): void };
              api.hydratePicker(document.querySelector("[data-first]")!, false);
              if (later) {
                await Promise.resolve();
                const root = document.querySelector("[data-second]")!;
                root.querySelector("input")!.value = "Later";
                root.querySelector("textarea")!.value = "Later";
                root.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked = true;
                root.querySelector("select")!.value = "First";
              }
              api.hydratePicker(document.querySelector("[data-second]")!, false);
              api.finishHydration();
            }, timing === "later edit");
            assert.deepEqual(await snapshot(converted), await snapshot(native));
            const current = await snapshot(native);
            assert.equal(current.controls[0]!.value, "Second");
            assert.equal(current.controls[4]!.value, timing === "later edit" ? "Later" : "Second");
            for (const page of pages) await page.locator("form").evaluateAll((forms: HTMLFormElement[]) => { for (const form of forms) form.reset(); });
            assert.deepEqual(await snapshot(converted), await snapshot(native));
            assert.deepEqual(warnings.filter((message) => /hydration|mismatch/i.test(message)), []);
            assert.deepEqual(errors, []);
          } finally { await browser.close(); }
        });
      }
      for (const fixture of ["late", "rich", "siblings"] as const) {
        for (const edited of fixture !== "rich" ? [false, true] : [false]) {
          it(`${engine} ${mode} ${fixture}${edited ? " edited" : ""} preserves selection and reset defaults`, async () => {
            const browser = await type.launch();
            const pages = await Promise.all([browser.newPage(), browser.newPage()]);
            const [native, converted] = pages as [Page, Page];
            const errors: string[] = [];
            const warnings: string[] = [];
            converted.on("console", (message) => { if (message.type() === "warning") warnings.push(message.text()); });
            for (const page of pages) page.on("pageerror", (error) => errors.push(error.message));
            try {
              const output = outputs.get(`${fixture}-${mode}`)!;
              await native.setContent(`<main>${sources[fixture]}<x-picker></x-picker></main>`);
              await native.addScriptTag({ path: live });
              await native.evaluate(() => (window as unknown as { Live: { lowerDocument(): void } }).Live.lowerDocument());
              await converted.setContent("<main></main>");
              if (fixture !== "rich") await converted.addScriptTag({ path: output.bundle });
              await converted.locator("main").evaluate((main, markup) => { main.innerHTML = markup; }, output.markup);
              if (edited) { await edit(native); await edit(converted); }
              if (fixture === "rich") {
                const server = await snapshot(converted);
                assert.equal(server.index, 0, "SSR must select the first matching explicit value");
                assert.deepEqual(server.selected, [true, false]);
                await converted.addScriptTag({ path: output.bundle });
              }
              await converted.evaluate(() => (window as unknown as { hydratePicker(): void }).hydratePicker());
              const expected = await snapshot(native);
              assert.deepEqual(await snapshot(converted), expected);
              assert.deepEqual(expected.defaults, [true, false]);
              assert.equal(expected.markers, 0);
              if (fixture !== "rich") {
                assert.equal(expected.value, edited ? "First" : "Second");
                assert.equal(expected.text, edited ? "Edited" : "Second");
                assert.equal(expected.area, edited ? "Edited" : "Second");
                assert.equal(expected.checked, edited);
                assert.equal(expected.textDefault, "Draft");
                assert.equal(expected.areaDefault, "Draft");
                assert.equal(expected.checkedDefault, true);
              }
              for (const page of pages) await page.locator("form").evaluate((form: HTMLFormElement) => form.reset());
              assert.deepEqual(await snapshot(converted), await snapshot(native));
              assert.deepEqual(warnings.filter((message) => /hydration|mismatch/i.test(message)), []);
              assert.deepEqual(errors, []);
            } finally { await browser.close(); }
          });
        }
      }
    }
  }
});
