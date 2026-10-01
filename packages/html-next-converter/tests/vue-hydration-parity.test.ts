import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";

import { compileScript, compileTemplate, parse as parseVue } from "@vue/compiler-sfc";
import { build } from "esbuild";
import { chromium, firefox, webkit, type BrowserType, type Page } from "playwright";

import { convertComponents, type ConversionGraph } from "../src/index.js";

import { assertPixelsEqual, launchParityBrowser } from "../../html-next/tests/pixel-parity.js";

const enabled = process.env.HTMLNEXT_TARGET_TEST === "1";
const nodeModulesPath = new URL("../../html-next/node_modules", import.meta.url).pathname;
const livePath = new URL("../../html-next/src/live.ts", import.meta.url).pathname;
const baseSource = `<template component="x-hydrated-field" status="early" summary="Hydration parity."><defs>
  <prop name="label" type="string">Current label.</prop>
  <state type="number" name="count" value="0"></state>
  <state name="text" value="server text"></state>
  <state type="boolean" name="checked" value="false"></state>
  <state name="choice" value="b"></state>
  <state type="list(unknown)" name="choices" value="['b']"></state>
  <state name="emptyChoice" type="string" ></state>
  <handler name="increment"><set name="count" expr:value="count + 1"></set></handler>
  <handler name="chooseB"><set name="choice" expr:value="'b'"></set></handler>
  <handler name="chooseA"><set name="choice" expr:value="'a'"></set></handler>
  <handler name="mutateChoices"><set name="choices.0" expr:value="'c'"></set><set name="count" expr:value="count + 1"></set></handler>
</defs><article><form><h2 $value="label"></h2><input .value="label" value="authored input"><textarea bind:value="text">authored text</textarea><input type="checkbox" checked bind:checked="checked"><select class="plain" bind:value="choice"><option value="a" selected>A</option><option value="b">B</option></select><select bind:value="choice"><option value="a">A</option><slot name="choice-option"><option value="b">B</option></slot></select><select class="projected" bind:value="choice"><option value="a">A</option><slot name="projected-option"><option value="b">Fallback B</option></slot></select><select class="multiple" multiple bind:value="choices"><option value="a" selected>A</option><option value="b">B</option><option value="c">C</option></select><select class="read-only" .value="choice"><option value="a">A</option><option value="b">B</option></select><select class="null-bind" bind:value="emptyChoice"><option value="">Empty</option><option value="null">Null</option></select><select class="null-read-only" .value="emptyChoice"><option value="">Empty</option><option value="null">Null</option></select><button type="button" on:click="increment">Increment</button><button type="button" class="choose-b" on:click="chooseB">B</button><button type="button" class="choose-a" on:click="chooseA">A</button><button type="button" class="mutate-choices" on:click="mutateChoices">Mutate choices</button><output $value="count"></output><output class="text-state" $value="text"></output><output class="checked-state" $value="checked"></output><output class="choice-state" $value="choice"></output></form></article></template>`;
const source = baseSource
  .replace("</defs>", `<state type="list(unknown)" name="combined" value="['b', 'c']"></state></defs>`)
  .replace("</form>", `<select class="null-multiple" multiple bind:value="emptyChoice"><option value="">Empty</option><option value="a">A</option></select>
    <select class="single-array" bind:value="combined"><option value="a">A</option><option value="b">B</option><option value="c">C</option><option value="b,c">Combined</option></select>
    <select class="multiple-property" multiple .value="choice"><option value="a">A</option><option value="b">B</option></select></form>`);

type HydratedState = {
  readonly value: string;
  readonly textarea: string;
  readonly checked: boolean;
  readonly choice: string;
  readonly plainChoice: string;
  readonly projectedChoice: string;
  readonly multipleChoices: readonly string[];
  readonly readOnlyChoice: string;
  readonly nullBoundChoice: string;
  readonly nullReadOnlyChoice: string;
  readonly nullMultipleChoices: readonly string[];
  readonly singleArrayChoice: string;
  readonly multiplePropertyChoices: readonly string[];
  readonly focused: boolean;
  readonly selection: readonly [number | null, number | null];
  readonly heading: string | null;
  readonly count: string | null;
  readonly textState: string | null;
  readonly checkedState: string | null;
  readonly choiceState: string | null;
};

async function snapshot(page: Page): Promise<{ behavior: HydratedState; pixels: Buffer }> {
  await page.mouse.move(0, 0);
  await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
  return {
    behavior: await page.evaluate(() => {
      const root = document.querySelector("#case")!;
      const input = root.querySelector("input")!;
      return {
        value: input.value,
        textarea: root.querySelector("textarea")!.value,
        checked: root.querySelector<HTMLInputElement>("input[type=checkbox]")!.checked,
        choice: root.querySelector("select")!.value,
        plainChoice: root.querySelector<HTMLSelectElement>("select.plain")!.value,
        projectedChoice: root.querySelector<HTMLSelectElement>("select.projected")!.value,
        multipleChoices: Array.from(root.querySelector<HTMLSelectElement>("select.multiple")!.selectedOptions, (option) => option.value),
        readOnlyChoice: root.querySelector<HTMLSelectElement>("select.read-only")!.value,
        nullBoundChoice: root.querySelector<HTMLSelectElement>("select.null-bind")!.value,
        nullReadOnlyChoice: root.querySelector<HTMLSelectElement>("select.null-read-only")!.value,
        nullMultipleChoices: Array.from(root.querySelector<HTMLSelectElement>("select.null-multiple")!.selectedOptions, (option) => option.value),
        singleArrayChoice: root.querySelector<HTMLSelectElement>("select.single-array")!.value,
        multiplePropertyChoices: Array.from(root.querySelector<HTMLSelectElement>("select.multiple-property")!.selectedOptions, (option) => option.value),
        focused: document.activeElement === input,
        selection: [input.selectionStart, input.selectionEnd] as const,
        heading: root.querySelector("h2")?.textContent ?? null,
        count: root.querySelector("output")?.textContent ?? null,
        textState: root.querySelector(".text-state")?.textContent ?? null,
        checkedState: root.querySelector(".checked-state")?.textContent ?? null,
        choiceState: root.querySelector(".choice-state")?.textContent ?? null,
      };
    }),
    pixels: await page.locator("#case").screenshot({ animations: "disabled" }),
  };
}

async function assertPixels(page: Page, expected: Buffer, actual: Buffer, stage: string): Promise<void> {
  await assertPixelsEqual(page, actual, expected, `${stage} pixels differ`);
}

describe.skipIf(!enabled)("public Vue converter SSR/hydration parity", () => {
  let directory = "";
  let liveBundle = "";
  const converted = new Map<ConversionGraph, { client: string; server: string }>();

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-vue-hydration-parity-"));
    await mkdir(join(directory, "components"));
    await writeFile(join(directory, "components", "field.html"), source);
    liveBundle = join(directory, "live.js");
    await build({ entryPoints: [livePath], outfile: liveBundle, bundle: true, format: "iife", globalName: "HtmlRuntime", platform: "browser", target: ["es2022"] });

    for (const mode of ["application", "library"] as const) {
      const outDirectory = join(directory, mode);
      const manifest = await convertComponents({ mode, target: "vue", entries: ["components/field.html"], root: directory, outDirectory });
      assert.deepEqual(manifest.components.map((component) => component.tag), ["x-hydrated-field"]);
      const file = join(outDirectory, manifest.components[0]!.artifact);
      const parsed = parseVue(await readFile(file, "utf8"), { filename: file });
      assert.deepEqual(parsed.errors, []);
      assert.doesNotMatch(parsed.descriptor.template!.content, /\bv-model(?::|\b)/, "native controls must not inherit Vue's model ownership");
      assert.match(parsed.descriptor.template!.content, /v-bind-control=/, "bound controls must use the native-value bridge");
      const script = compileScript(parsed.descriptor, { id: `hydration-${mode}`, inlineTemplate: true });
      const serverScript = compileScript(parsed.descriptor, { id: `hydration-${mode}` });
      const ssrTemplate = compileTemplate({
        source: parsed.descriptor.template!.content,
        filename: file,
        id: `hydration-${mode}`,
        ssr: true,
        ssrCssVars: [],
        compilerOptions: { bindingMetadata: serverScript.bindings ?? {} },
      });
      assert.deepEqual(ssrTemplate.errors, []);
      assert.match(ssrTemplate.code, /ssrRenderComponent\(\$setup\["SelectedOptions"\]/, "Vue's SSR compiler must render options through the selection bridge");
      await writeFile(file.replace(/\.vue$/, ".ts"), script.content);
      const ssrComponentFile = file.replace(/\.vue$/, ".ssr.ts");
      await writeFile(ssrComponentFile, `${serverScript.content.replace("export default", "const Component =")}
${ssrTemplate.code}
export default Object.assign(Component, { ssrRender });
`);
      const entryImport = `import { XHydratedField } from "./vue/${mode === "application" ? "application" : "index"}";`;
      const clientEntry = join(outDirectory, "hydrate.ts");
      const client = join(outDirectory, "hydrate.js");
      await writeFile(clientEntry, `import { createSSRApp, h, ref } from "vue";
${entryImport}
const label = ref("Server");
window.changeHydratedLabel = (value) => { label.value = value; };
createSSRApp({ render: () => h(XHydratedField, { id: "case", label: label.value }, {
  "projected-option": () => h("option", { id: "projected-option", value: "b" }, "Projected B"),
}) }).mount(document.querySelector("main"));\n`);
      const serverEntry = join(outDirectory, "server.ts");
      await writeFile(serverEntry, `import { createSSRApp, h } from "vue";
import { renderToString } from "@vue/server-renderer";
import XHydratedField from "./${manifest.components[0]!.artifact.replace(/\.vue$/, ".ssr")}";
export const render = () => renderToString(createSSRApp({ render: () => h(XHydratedField, { id: "case", label: "Server" }, {
  "projected-option": () => h("option", { id: "projected-option", value: "b" }, "Projected B"),
}) }));\n`);
      const plugin = { name: "compiled-vue-sfc", setup(pluginBuild: Parameters<NonNullable<Parameters<typeof build>[0]["plugins"]>[number]["setup"]>[0]) {
        pluginBuild.onResolve({ filter: /\.vue$/ }, (args) => ({ path: resolve(args.resolveDir, args.path.replace(/\.vue$/, ".ts")) }));
      } };
      await build({ entryPoints: [clientEntry], outfile: client, bundle: true, format: "iife", platform: "browser", target: ["es2022"], nodePaths: [nodeModulesPath], plugins: [plugin] });
      const serverBuild = await build({ entryPoints: [serverEntry], bundle: true, format: "esm", platform: "node", write: false, nodePaths: [nodeModulesPath], plugins: [plugin] });
      const serverModule = await import(`data:text/javascript;base64,${Buffer.from(serverBuild.outputFiles[0]!.text).toString("base64")}`);
      const server = await serverModule.render() as string;
      assert.match(server, /<input[^>]*value="Server"/);
      assert.match(server, /<textarea[^>]*>server text<\/textarea>/);
      assert.match(server, /<option[^>]*value="b"[^>]*selected(?:="")?[^>]*>B<\/option>/);
      assert.match(server, /<select class="plain">[\s\S]*?<option value="a">A<\/option><option value="b" selected(?:="")?>B<\/option>[\s\S]*?<\/select>/);
      const readOnlyOptions = /<select class="read-only"[^>]*>([\s\S]*?)<\/select>/.exec(server)?.[1] ?? "";
      assert.match(readOnlyOptions, /<option value="b" selected(?:="")?>B<\/option>/);
      for (const selectClass of ["null-bind", "null-read-only"] as const) {
        const options = new RegExp(`<select class="${selectClass}"[^>]*>([\\s\\S]*?)<\\/select>`).exec(server)?.[1] ?? "";
        if (selectClass === "null-bind") {
          assert.match(options, /<option value(?:="")? selected(?:="")?>Empty<\/option>/, "two-way null binding selects the empty option");
        } else {
          assert.match(options, /<option value="null" selected(?:="")?>Null<\/option>/, "native .value assignment coerces null to the string null");
        }
      }
      assert.match(server, /<option[^>]*id="projected-option"[^>]*selected(?:="")?[^>]*>Projected B<\/option>/);
      converted.set(mode, { client, server });
    }
  });

  afterAll(async () => { if (directory !== "") await rm(directory, { recursive: true, force: true }); });

  for (const mode of ["application", "library"] as const) {
    for (const [engine, browserType] of [["Chromium", chromium], ["Firefox", firefox], ["WebKit", webkit]] as const satisfies ReadonlyArray<readonly [string, BrowserType]>) {
      it(`${engine} ${mode} preserves edited controls, focus, selection, and native reset behavior`, async () => {
        const browser = await launchParityBrowser(browserType);
        const [live, vue] = await Promise.all([browser.newPage(), browser.newPage()]);
        const errors: string[] = [];
        try {
          const artifacts = converted.get(mode)!;
          const serverPage = await browser.newPage();
          let liveServer: string;
          try {
            await serverPage.setContent(`${source}<main><x-hydrated-field id="case" label="Server"><option id="projected-option" slot="projected-option" value="b">Projected B</option></x-hydrated-field></main>`);
            await serverPage.addScriptTag({ path: liveBundle });
            liveServer = await serverPage.evaluate(() => {
              window.HtmlRuntime.lowerDocument();
              return (window.HtmlRuntime as typeof window.HtmlRuntime & { serializeRenderedForm(container: Element): string })
                .serializeRenderedForm(document.querySelector("main")!);
            });
            assert.match(liveServer, /data-html-next-form-defaults=/, "rendered form must carry displaced native reset defaults");
          } finally { await serverPage.close(); }
          for (const page of [live, vue]) {
            page.on("pageerror", (error) => errors.push(error.message));
            // Focus and selection are compared as behavior; the blinking caret is not a stable pixel.
            const stableStyle = `<style>
              input, textarea, select, button { appearance: none; box-sizing: border-box; font: inherit; color: #111; background: #fff; border: 1px solid #888; border-radius: 0; }
              input, textarea { caret-color: transparent; }
              input[type=checkbox] { width: 14px; height: 14px; vertical-align: middle; }
              input[type=checkbox]:checked { background: #333; }
              button { background: #eee; }
            </style>`;
            await page.setContent(page === live ? `${stableStyle}${source}${liveServer}` : `${stableStyle}<main>${artifacts.server}</main>`);
          }
          const [serverLive, serverVue] = await Promise.all([snapshot(live), snapshot(vue)]);
          assert.deepEqual(serverLive.behavior.nullMultipleChoices, [], "a null multiple-select model selects no option");
          assert.equal(serverLive.behavior.singleArrayChoice, "b,c", "a single select uses native string coercion for an array");
          assert.deepEqual(serverLive.behavior.multiplePropertyChoices, ["b"], "a multiple select .value property targets one option");
          assert.deepEqual(serverVue.behavior, serverLive.behavior, "pre-hydration server form behavior differs");
          await assertPixels(vue, serverLive.pixels, serverVue.pixels, "pre-hydration server output");
          for (const page of [live, vue]) await page.evaluate(() => document.querySelector<HTMLFormElement>("#case form")!.reset());
          const [serverResetLive, serverResetVue] = await Promise.all([snapshot(live), snapshot(vue)]);
          assert.deepEqual(serverResetLive.behavior.nullMultipleChoices, []);
          assert.deepEqual(serverResetVue.behavior, serverResetLive.behavior, "pre-hydration native form reset differs");
          await assertPixels(vue, serverResetLive.pixels, serverResetVue.pixels, "pre-hydration native form reset");
          for (const page of [live, vue]) {
            await page.evaluate(() => {
              const root = document.querySelector("#case")!;
              const input = root.querySelector("input")!;
              input.value = "user edit";
              root.querySelector("textarea")!.value = "edited text";
              root.querySelector<HTMLInputElement>("input[type=checkbox]")!.checked = true;
              for (const select of root.querySelectorAll("select")) {
                select.value = select.classList.contains("null-bind") || select.classList.contains("null-read-only") ? "null" : "a";
              }
              input.focus();
              input.setSelectionRange(2, 6);
            });
          }
          await live.addScriptTag({ path: liveBundle });
          await live.evaluate(() => window.HtmlRuntime.lowerDocument());
          await vue.addScriptTag({ path: artifacts.client });
          const [hydratedLive, hydratedVue] = await Promise.all([snapshot(live), snapshot(vue)]);
          assert.deepEqual(hydratedLive.behavior, {
            value: "user edit", textarea: "edited text", checked: true, choice: "a", focused: true,
            selection: [2, 6], heading: "Server", count: "0", plainChoice: "a", projectedChoice: "a", readOnlyChoice: "a",
            multipleChoices: ["a"], nullBoundChoice: "null", nullReadOnlyChoice: "null",
            nullMultipleChoices: ["a"],
            singleArrayChoice: "a",
            multiplePropertyChoices: ["a"],
            textState: "server text", checkedState: "false", choiceState: "b",
          });
          assert.deepEqual(hydratedVue.behavior, hydratedLive.behavior, "hydrated behavior differs");
          await assertPixels(vue, hydratedLive.pixels, hydratedVue.pixels, "hydrated");

          await Promise.all([live, vue].map((page) => page.locator("#case button").first().click()));
          await Promise.all([live, vue].map((page) => page.waitForFunction(() => document.querySelector("#case output")?.textContent === "1")));
          await live.evaluate(() => (window.HtmlRuntime as typeof window.HtmlRuntime & {
            updateComponentProps(element: Element, values: Record<string, unknown>): void;
          }).updateComponentProps(document.querySelector("#case")!, { label: "Next" }));
          await vue.evaluate(() => window.changeHydratedLabel("Next"));
          await Promise.all([live, vue].map((page) => page.waitForFunction(() => document.querySelector("#case h2")?.textContent === "Next")));
          const [updatedLive, updatedVue] = await Promise.all([snapshot(live), snapshot(vue)]);
          assert.deepEqual(updatedVue.behavior, updatedLive.behavior, "post-hydration update behavior differs");
          await assertPixels(vue, updatedLive.pixels, updatedVue.pixels, "post-hydration update");
          await Promise.all([live, vue].map((page) => page.locator("#case .mutate-choices").click()));
          const [mutatedLive, mutatedVue] = await Promise.all([snapshot(live), snapshot(vue)]);
          assert.deepEqual(mutatedLive.behavior.multipleChoices, ["c"]);
          assert.deepEqual(mutatedVue.behavior, mutatedLive.behavior, "in-place model update after hydration differs");
          await assertPixels(vue, mutatedLive.pixels, mutatedVue.pixels, "in-place model update after hydration");
          for (const [selector, choice] of [[".choose-a", "a"], [".choose-b", "b"]] as const) {
            await Promise.all([live, vue].map((page) => page.locator(`#case ${selector}`).click()));
            await Promise.all([live, vue].map((page) => page.waitForFunction((value) => document.querySelector<HTMLSelectElement>("#case select")?.value === value, choice)));
            const [selectedLive, selectedVue] = await Promise.all([snapshot(live), snapshot(vue)]);
            assert.deepEqual(selectedVue.behavior, selectedLive.behavior, `${choice} model update behavior differs`);
            await assertPixels(vue, selectedLive.pixels, selectedVue.pixels, `${choice} model update`);
          }
          for (const page of [live, vue]) {
            await page.evaluate(() => {
              document.querySelector<HTMLInputElement>("#case input")!.value = "later native edit";
              for (const select of document.querySelectorAll<HTMLSelectElement>("#case select")) {
                select.value = select.classList.contains("null-bind") || select.classList.contains("null-read-only") ? "null" : "a";
              }
            });
          }
          await Promise.all([live, vue].map((page) => page.locator("#case button").first().click()));
          await Promise.all([live, vue].map((page) => page.evaluate(() => {
            if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
          })));
          const [laterLive, laterVue] = await Promise.all([snapshot(live), snapshot(vue)]);
          assert.equal(laterLive.behavior.value, "later native edit");
          assert.equal(laterLive.behavior.plainChoice, "a");
          assert.equal(laterLive.behavior.projectedChoice, "a");
          assert.deepEqual(laterVue.behavior, laterLive.behavior, "later native edit behavior differs");
          await assertPixels(vue, laterLive.pixels, laterVue.pixels, "later native edit");
          for (const [selector, choice] of [[".choose-a", "a"], [".choose-b", "b"]] as const) {
            await Promise.all([live, vue].map((page) => page.locator(`#case ${selector}`).click()));
            await Promise.all([live, vue].map((page) => page.waitForFunction((value) =>
              document.querySelector("#case .choice-state")?.textContent === value, choice)));
            const [retakenLive, retakenVue] = await Promise.all([snapshot(live), snapshot(vue)]);
            assert.deepEqual(retakenVue.behavior, retakenLive.behavior, `${choice} post-edit model update behavior differs`);
            await assertPixels(vue, retakenLive.pixels, retakenVue.pixels, `${choice} post-edit model update`);
          }
          const defaults = await Promise.all([live, vue].map((page) => page.evaluate(() => {
            const root = document.querySelector("#case")!;
            return {
              input: root.querySelector<HTMLInputElement>("input")!.defaultValue,
              textarea: root.querySelector<HTMLTextAreaElement>("textarea")!.defaultValue,
              checked: root.querySelector<HTMLInputElement>("input[type=checkbox]")!.defaultChecked,
              single: Array.from(root.querySelector<HTMLSelectElement>("select.plain")!.options, (option) => option.defaultSelected),
              projected: Array.from(root.querySelector<HTMLSelectElement>("select.projected")!.options, (option) => option.defaultSelected),
              multiple: Array.from(root.querySelector<HTMLSelectElement>("select.multiple")!.options, (option) => option.defaultSelected),
              hydrationMarkers: root.querySelectorAll("[data-html-next-form-defaults]").length,
            };
          })));
          assert.deepEqual(defaults[1], defaults[0], "native reset defaults after hydration differ");
          assert.deepEqual(defaults[0], {
            input: "authored input", textarea: "authored text", checked: true,
            single: [true, false], projected: [false, false], multiple: [true, false, false],
            hydrationMarkers: 0,
          });
          for (const page of [live, vue]) await page.evaluate(() => document.querySelector<HTMLFormElement>("#case form")!.reset());
          const [resetLive, resetVue] = await Promise.all([snapshot(live), snapshot(vue)]);
          assert.deepEqual(resetLive.behavior.nullMultipleChoices, []);
          assert.deepEqual(resetVue.behavior, resetLive.behavior, "native form reset after hydration differs");
          await assertPixels(vue, resetLive.pixels, resetVue.pixels, "native form reset after hydration");
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
  interface Window {
    changeHydratedLabel(value: string): void;
  }
}
