import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";

import { compileScript, compileTemplate, parse as parseVue } from "@vue/compiler-sfc";
import { build } from "esbuild";
import { chromium, firefox, webkit, type BrowserType, type Page } from "playwright";

import { convertComponents, type ConversionGraph } from "../src/index.js";

const enabled = process.env.HTMLNEXT_TARGET_TEST === "1";
const nodeModulesPath = new URL("../../html-next/node_modules", import.meta.url).pathname;
const livePath = new URL("../../html-next/src/live.ts", import.meta.url).pathname;
const provider = `<template component="x-steps" status="early" summary="Context provider."><defs>
  <state name="current" :value="1" context></state>
  <handler name="next"><set name="current" :value="current + 1"></set></handler>
</defs><section><button type="button" on:click="next">Next</button><slot></slot></section></template>`;
const reader = `<template component="x-step" status="early" summary="Context reader."><defs>
  <prop name="number" type="number" required>Step number.</prop>
  <context name="current" from="x-steps" as="activeStep"></context>
</defs><p :data-active="activeStep = number ? 'yes' : 'no'"><slot></slot></p></template>`;
const invocation = `<x-steps id="case"><x-step id="outer-one" number="1">Outer one</x-step>
  <x-step id="outer-two" number="2">Outer two</x-step>
  <x-steps id="inner"><x-step id="inner-one" number="1">Inner one</x-step>
    <x-step id="inner-two" number="2">Inner two</x-step></x-steps></x-steps>`;

type Behavior = { readonly outer: readonly (string | null)[]; readonly inner: readonly (string | null)[] };

async function snapshot(page: Page, expected: Behavior): Promise<{ readonly behavior: Behavior; readonly pixels: Buffer }> {
  await page.waitForFunction((value) => {
    const ids = ["outer-one", "outer-two", "inner-one", "inner-two"];
    const current = ids.map((id) => document.getElementById(id)?.getAttribute("data-active") ?? null);
    return JSON.stringify(current) === JSON.stringify([...value.outer, ...value.inner]);
  }, expected);
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  return {
    behavior: await page.evaluate(() => ({
      outer: ["outer-one", "outer-two"].map((id) => document.getElementById(id)?.getAttribute("data-active") ?? null),
      inner: ["inner-one", "inner-two"].map((id) => document.getElementById(id)?.getAttribute("data-active") ?? null),
    })),
    pixels: await page.locator("#case").screenshot({ animations: "disabled" }),
  };
}

describe.skipIf(!enabled)("public Vue converter projected context parity", () => {
  let directory = "";
  let liveBundle = "";
  const converted = new Map<ConversionGraph, { readonly fresh: string; readonly hydrate: string; readonly server: string }>();

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-vue-context-slot-"));
    await mkdir(join(directory, "components"));
    await writeFile(join(directory, "components", "steps.html"), provider);
    await writeFile(join(directory, "components", "step.html"), reader);
    liveBundle = join(directory, "live.js");
    await build({ entryPoints: [livePath], outfile: liveBundle, bundle: true, format: "iife", globalName: "HtmlRuntime", platform: "browser", target: ["es2022"] });

    for (const mode of ["application", "library"] as const) {
      const outDirectory = join(directory, mode);
      const manifest = await convertComponents({ mode, target: "vue", entries: ["components/steps.html", "components/step.html"], root: directory, outDirectory });
      assert.deepEqual(manifest.components.map((component) => component.tag).sort(), ["x-step", "x-steps"]);
      for (const component of manifest.components) {
        const file = join(outDirectory, component.artifact);
        const parsed = parseVue(await readFile(file, "utf8"), { filename: file });
        assert.deepEqual(parsed.errors, []);
        await writeFile(file.replace(/\.vue$/, ".ts"), compileScript(parsed.descriptor, { id: `context-slot-${mode}-${component.name}`, inlineTemplate: true }).content);
        const serverScript = compileScript(parsed.descriptor, { id: `context-slot-${mode}-${component.name}` });
        const serverTemplate = compileTemplate({
          source: parsed.descriptor.template!.content,
          filename: file,
          id: `context-slot-${mode}-${component.name}`,
          ssr: true,
          ssrCssVars: [],
          compilerOptions: { bindingMetadata: serverScript.bindings ?? {} },
        });
        assert.deepEqual(serverTemplate.errors, []);
        await writeFile(file.replace(/\.vue$/, ".ssr.ts"), `${serverScript.content.replace("export default", "const Component =")}
${serverTemplate.code}
export default Object.assign(Component, { ssrRender });
`);
      }
      const entry = join(outDirectory, "entry.ts");
      const bundle = join(outDirectory, "vue.js");
      await writeFile(entry, `import { createApp, h } from "vue";
import { XSteps, XStep } from "./vue/${mode === "application" ? "application" : "index"}";
const step = (id, number, text) => h(XStep, { id, number }, () => text);
createApp({ render: () => h(XSteps, { id: "case" }, { default: () => [
  step("outer-one", 1, "Outer one"), step("outer-two", 2, "Outer two"),
  h(XSteps, { id: "inner" }, { default: () => [step("inner-one", 1, "Inner one"), step("inner-two", 2, "Inner two")] }),
] }) }).mount(document.querySelector("main"));
`);
      await build({
        entryPoints: [entry], outfile: bundle, bundle: true, format: "iife", platform: "browser", target: ["es2022"], nodePaths: [nodeModulesPath],
        plugins: [{ name: "compiled-vue-sfc", setup(pluginBuild) {
          pluginBuild.onResolve({ filter: /\.vue$/ }, (args) => ({ path: resolve(args.resolveDir, args.path.replace(/\.vue$/, ".ts")) }));
        } }],
      });
      const hydrateEntry = join(outDirectory, "hydrate.ts");
      const hydrate = join(outDirectory, "hydrate.js");
      await writeFile(hydrateEntry, `import { createSSRApp, h } from "vue";
import { XSteps, XStep } from "./vue/${mode === "application" ? "application" : "index"}";
const step = (id, number, text) => h(XStep, { id, number }, () => text);
createSSRApp({ render: () => h(XSteps, { id: "case" }, { default: () => [
  step("outer-one", 1, "Outer one"), step("outer-two", 2, "Outer two"),
  h(XSteps, { id: "inner" }, { default: () => [step("inner-one", 1, "Inner one"), step("inner-two", 2, "Inner two")] }),
] }) }).mount(document.querySelector("main"));
`);
      await build({
        entryPoints: [hydrateEntry], outfile: hydrate, bundle: true, format: "iife", platform: "browser", target: ["es2022"], nodePaths: [nodeModulesPath],
        plugins: [{ name: "compiled-vue-sfc", setup(pluginBuild) {
          pluginBuild.onResolve({ filter: /\.vue$/ }, (args) => ({ path: resolve(args.resolveDir, args.path.replace(/\.vue$/, ".ts")) }));
        } }],
      });
      const serverEntry = join(outDirectory, "server.ts");
      await writeFile(serverEntry, `import { createSSRApp, h } from "vue";
import { renderToString } from "@vue/server-renderer";
import { XSteps, XStep } from "./vue/${mode === "application" ? "application" : "index"}";
const step = (id, number, text) => h(XStep, { id, number }, () => text);
export const render = () => renderToString(createSSRApp({ render: () => h(XSteps, { id: "case" }, { default: () => [
  step("outer-one", 1, "Outer one"), step("outer-two", 2, "Outer two"),
  h(XSteps, { id: "inner" }, { default: () => [step("inner-one", 1, "Inner one"), step("inner-two", 2, "Inner two")] }),
] }) }));
`);
      const serverBuild = await build({
        entryPoints: [serverEntry], bundle: true, format: "esm", platform: "node", write: false, nodePaths: [nodeModulesPath],
        plugins: [{ name: "compiled-vue-sfc-ssr", setup(pluginBuild) {
          pluginBuild.onResolve({ filter: /\.vue$/ }, (args) => ({ path: resolve(args.resolveDir, args.path.replace(/\.vue$/, ".ssr.ts")) }));
        } }],
      });
      const serverModule = await import(`data:text/javascript;base64,${Buffer.from(serverBuild.outputFiles[0]!.text).toString("base64")}`);
      const server = await serverModule.render() as string;
      assert.match(server, /<section[^>]*id="case"/);
      converted.set(mode, { fresh: bundle, hydrate, server });
    }
  });

  afterAll(async () => { if (directory !== "") await rm(directory, { recursive: true, force: true }); });

  for (const mode of ["application", "library"] as const) {
    for (const [engine, browserType] of [["Chromium", chromium], ["Firefox", firefox], ["WebKit", webkit]] as const satisfies ReadonlyArray<readonly [string, BrowserType]>) {
      it(`${engine} ${mode} resolves nearest logical provider through nested slots and hydration`, async () => {
        const browser = await browserType.launch({ headless: true });
        const [live, vue, hydrated] = await Promise.all([browser.newPage(), browser.newPage(), browser.newPage()]);
        const pages = [live, vue, hydrated];
        const errors: string[] = [];
        const warnings: string[] = [];
        try {
          for (const page of pages) page.on("pageerror", (error) => errors.push(error.message));
          hydrated.on("console", (message) => { if (message.type() === "warning") warnings.push(message.text()); });
          await live.setContent(`${provider}${reader}<main>${invocation}</main>`);
          await live.addScriptTag({ path: liveBundle });
          await live.evaluate(() => window.HtmlRuntime.lowerDocument());
          await vue.setContent("<main></main>");
          const output = converted.get(mode)!;
          await vue.addScriptTag({ path: output.fresh });
          await hydrated.setContent(`<main>${output.server}</main>`);
          const initial: Behavior = { outer: ["yes", "no"], inner: ["yes", "no"] };
          const [serverLive, serverHydrated] = await Promise.all([snapshot(live, initial), snapshot(hydrated, initial)]);
          assert.deepEqual(serverHydrated.behavior, serverLive.behavior, "server-rendered context differs");
          assert.deepEqual(serverHydrated.pixels, serverLive.pixels, "server-rendered context pixels differ");
          await hydrated.addScriptTag({ path: output.hydrate });
          const compare = async (expected: Behavior) => {
            const [liveResult, vueResult, hydratedResult] = await Promise.all([snapshot(live, expected), snapshot(vue, expected), snapshot(hydrated, expected)]);
            assert.deepEqual(liveResult.behavior, expected);
            assert.deepEqual(vueResult.behavior, expected);
            assert.deepEqual(vueResult.pixels, liveResult.pixels);
            assert.deepEqual(hydratedResult.behavior, expected, "hydrated context differs");
            assert.deepEqual(hydratedResult.pixels, liveResult.pixels, "hydrated context pixels differ");
          };
          await compare(initial);
          await Promise.all(pages.map((page) => page.locator("#case > button").click()));
          await compare({ outer: ["no", "yes"], inner: ["yes", "no"] });
          await Promise.all(pages.map((page) => page.locator("#inner > button").click()));
          await compare({ outer: ["no", "yes"], inner: ["no", "yes"] });
          assert.deepEqual(warnings.filter((message) => !message.startsWith("Feature flags ") && /hydration|mismatch/i.test(message)), [], "Vue reported a hydration mismatch");
          assert.deepEqual(errors, []);
        } finally {
          await Promise.all(pages.map((page) => page.close()));
          await browser.close();
        }
      });
    }
  }
});
