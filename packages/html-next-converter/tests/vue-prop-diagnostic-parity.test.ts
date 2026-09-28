import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";

import { compileScript, parse as parseVue } from "@vue/compiler-sfc";
import { build } from "esbuild";
import { chromium, firefox, webkit, type BrowserType, type Page } from "playwright";

import { convertComponents, type ConversionGraph } from "../src/index.js";

import { assertPixelsEqual } from "../../html-next/tests/pixel-parity.js";

const enabled = process.env.HTMLNEXT_TARGET_TEST === "1";
const nodeModulesPath = new URL("../../html-next/node_modules", import.meta.url).pathname;
const livePath = new URL("../../html-next/src/live.ts", import.meta.url).pathname;
const source = `<template component="x-required-number" status="early" summary="Required numeric prop."><defs>
  <prop name="n" type="number" required>Number.</prop>
</defs><output $value="n + 1"></output></template>`;

interface Case {
  readonly name: string;
  readonly attribute?: string;
  readonly code?: string;
  readonly output?: string;
}

const cases: readonly Case[] = [
  { name: "missing required", code: "HC020" },
  { name: "invalid number", attribute: "abc", code: "HR002" },
  { name: "numeric attribute", attribute: "42", output: "43" },
];

async function observe(page: Page): Promise<{ readonly output: string | null; readonly pixels: Buffer | null }> {
  await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
  const root = page.locator("#case");
  if (await root.count() === 0) return { output: null, pixels: null };
  return { output: await root.textContent(), pixels: await root.screenshot({ animations: "disabled" }) };
}

async function assertObservedEqual(page: Page, actual: Awaited<ReturnType<typeof observe>>, expected: Awaited<ReturnType<typeof observe>>, message: string): Promise<void> {
  assert.equal(actual.output, expected.output, message);
  assert.equal(actual.pixels === null, expected.pixels === null, message);
  if (actual.pixels !== null && expected.pixels !== null) await assertPixelsEqual(page, actual.pixels, expected.pixels, message);
}

describe.skipIf(!enabled)("public Vue converter prop diagnostic parity", () => {
  let directory = "";
  let liveBundle = "";
  const converted = new Map<ConversionGraph, string>();

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-vue-prop-diagnostics-"));
    await mkdir(join(directory, "components"));
    await writeFile(join(directory, "components", "required-number.html"), source);
    liveBundle = join(directory, "live.js");
    await build({ entryPoints: [livePath], outfile: liveBundle, bundle: true, format: "iife", globalName: "HtmlRuntime", platform: "browser", target: ["es2022"] });

    for (const mode of ["application", "library"] as const) {
      const outDirectory = join(directory, mode);
      const manifest = await convertComponents({ mode, target: "vue", entries: ["components/required-number.html"], root: directory, outDirectory });
      const file = join(outDirectory, manifest.components[0]!.artifact);
      const parsed = parseVue(await readFile(file, "utf8"), { filename: file });
      assert.deepEqual(parsed.errors, []);
      await writeFile(file.replace(/\.vue$/, ".ts"), compileScript(parsed.descriptor, { id: `prop-diagnostics-${mode}`, inlineTemplate: true }).content);
      const entry = join(outDirectory, "entry.ts");
      const bundle = join(outDirectory, "vue.js");
      await writeFile(entry, `import { createApp, h, nextTick, ref } from "vue";
import { XRequiredNumber } from "./vue/${mode === "application" ? "application" : "index"}";
let current;
window.mountCase = (attributes) => {
  current = ref(attributes.n);
  const app = createApp({ render: () => h(XRequiredNumber, { id: "case", ...attributes, ...(Object.hasOwn(attributes, "n") ? { n: current.value } : {}) }) });
  app.config.errorHandler = (error) => {
    window.vueDiagnostic = error?.diagnostic?.code ?? "THROWN: " + error?.message;
    window.vueErrors.push(window.vueDiagnostic);
  };
  app.mount(document.querySelector("main"));
};
window.setCase = async (value) => { current.value = value; await nextTick(); };\n`);
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
      it(`${engine} ${mode} preserves required and numeric prop behavior`, async () => {
        const browser = await browserType.launch({ headless: true });
        try {
          for (const testCase of cases) {
            const [live, vue] = await Promise.all([browser.newPage(), browser.newPage()]);
            try {
              const attribute = testCase.attribute === undefined ? "" : ` n=${JSON.stringify(testCase.attribute)}`;
              await live.setContent(`${source}<main><x-required-number id="case"${attribute}></x-required-number></main>`);
              await live.addScriptTag({ path: liveBundle });
              const liveCode = await live.evaluate(() => {
                try { window.HtmlRuntime.lowerDocument(); return null; }
                catch (error) { return (error as { diagnostic?: { code?: string } }).diagnostic?.code ?? "THROWN"; }
              });
              await vue.setContent("<main></main>");
              await vue.addScriptTag({ path: converted.get(mode)! });
              const vueCode = await vue.evaluate((value) => {
                window.vueDiagnostic = null;
                window.vueErrors = [];
                try { window.mountCase(value === null ? {} : { n: value }); }
                catch (error) { window.vueDiagnostic = (error as { diagnostic?: { code?: string }; message?: string }).diagnostic?.code ?? `THROWN: ${(error as Error).message}`; }
                return window.vueDiagnostic;
              }, testCase.attribute ?? null);
              assert.equal(liveCode, testCase.code ?? null, `${testCase.name}: live diagnostic changed`);
              assert.equal(vueCode, liveCode, `${testCase.name}: Vue diagnostic differs`);
              assert.deepEqual(await vue.evaluate(() => window.vueErrors), liveCode === null ? [] : [liveCode], `${testCase.name}: additional Vue errors`);
              if (testCase.output !== undefined) {
                const [liveResult, vueResult] = await Promise.all([observe(live), observe(vue)]);
                assert.equal(liveResult.output, testCase.output);
                await assertObservedEqual(vue, vueResult, liveResult, `${testCase.name}: rendered output differs`);
              }
            } finally {
              await Promise.all([live.close(), vue.close()]);
            }
          }
          const [live, vue] = await Promise.all([browser.newPage(), browser.newPage()]);
          try {
            await live.setContent(`${source}<main><x-required-number id="case" n="42"></x-required-number></main>`);
            await live.addScriptTag({ path: liveBundle });
            await live.evaluate(() => window.HtmlRuntime.lowerDocument());
            await vue.setContent("<main></main>");
            await vue.addScriptTag({ path: converted.get(mode)! });
            await vue.evaluate(() => { window.vueDiagnostic = null; window.vueErrors = []; window.mountCase({ n: "42" }); });
            await assertObservedEqual(vue, await observe(vue), await observe(live), "initial reactive prop output differs");

            const liveCode = await live.evaluate(() => {
              try { (window.HtmlRuntime as typeof window.HtmlRuntime & { updateComponentProps(element: Element, props: Record<string, unknown>): void }).updateComponentProps(document.querySelector("#case")!, { n: "bad" }); return null; }
              catch (error) { return (error as { diagnostic?: { code?: string } }).diagnostic?.code ?? "THROWN"; }
            });
            await vue.evaluate(() => window.setCase("bad"));
            assert.equal(liveCode, "HR002");
            assert.deepEqual(await vue.evaluate(() => window.vueErrors), [liveCode], "invalid update diagnostic differs");
            await assertObservedEqual(vue, await observe(vue), await observe(live), "invalid update changed rendered output");

            await live.evaluate(() => (window.HtmlRuntime as typeof window.HtmlRuntime & { updateComponentProps(element: Element, props: Record<string, unknown>): void }).updateComponentProps(document.querySelector("#case")!, { n: "43" }));
            await vue.evaluate(() => window.setCase("43"));
            const [liveRecovered, vueRecovered] = await Promise.all([observe(live), observe(vue)]);
            assert.equal(liveRecovered.output, "44");
            await assertObservedEqual(vue, vueRecovered, liveRecovered, "valid update did not recover parity");
          } finally {
            await Promise.all([live.close(), vue.close()]);
          }
        } finally {
          await browser.close();
        }
      });
    }
  }
});

declare global {
  interface Window {
    HtmlRuntime: { lowerDocument(): void };
    mountCase: (attributes: Record<string, unknown>) => void;
    setCase: (value: unknown) => Promise<void>;
    vueDiagnostic: string | null;
    vueErrors: string[];
  }
}
