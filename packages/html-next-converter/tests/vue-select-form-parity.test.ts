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
const source = `<template component="x-choice" status="early" summary="A form-associated select."><defs>
  <state name="choice" value="b"></state>
</defs><select name="choice" required bind:value="choice" :data-current="choice">
  <option value="">Choose</option><option value="a" selected>Alpha</option><option value="b">Beta</option>
</select></template>`;
const invocation = `<form id="owner"><button type="submit">Send</button></form><x-choice id="case" form="owner"></x-choice>`;

async function snapshot(page: Page) {
  await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
  return {
    behavior: await page.evaluate(() => {
      const select = document.querySelector<HTMLSelectElement>("#case")!;
      const form = document.querySelector<HTMLFormElement>("#owner")!;
      return {
        tag: select.localName,
        owner: select.form?.id ?? null,
        inElements: Array.from(form.elements).includes(select),
        value: select.value,
        current: select.getAttribute("data-current"),
        selected: Array.from(select.options, (option) => [option.value, option.selected, option.defaultSelected]),
        valid: form.matches(":valid"),
        valueMissing: select.validity.valueMissing,
        data: Array.from(new FormData(form), ([name, value]) => [name, String(value)]),
        invalidEvents: window.selectFormTrace.invalid,
        submits: window.selectFormTrace.submits,
      };
    }),
    pixels: await page.locator("#case").screenshot({ animations: "disabled" }),
  };
}

describe.skipIf(!enabled)("public Vue converter form-associated select root parity", () => {
  let directory = "";
  let liveBundle = "";
  const converted = new Map<ConversionGraph, { readonly client: string; readonly hydrate: string; readonly server: string }>();

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-vue-select-form-"));
    await mkdir(join(directory, "components"));
    await writeFile(join(directory, "components", "choice.html"), source);
    liveBundle = join(directory, "live.js");
    await build({ entryPoints: [livePath], outfile: liveBundle, bundle: true, format: "iife", globalName: "HtmlRuntime", platform: "browser", target: ["es2022"] });

    for (const mode of ["application", "library"] as const) {
      const outDirectory = join(directory, mode);
      const manifest = await convertComponents({ mode, target: "vue", entries: ["components/choice.html"], root: directory, outDirectory });
      assert.deepEqual(manifest.components.map((component) => component.tag), ["x-choice"]);
      const file = join(outDirectory, manifest.components[0]!.artifact);
      const parsed = parseVue(await readFile(file, "utf8"), { filename: file });
      assert.deepEqual(parsed.errors, []);
      await writeFile(file.replace(/\.vue$/, ".ts"), compileScript(parsed.descriptor, { id: `select-form-${mode}`, inlineTemplate: true }).content);
      const serverScript = compileScript(parsed.descriptor, { id: `select-form-${mode}` });
      const serverTemplate = compileTemplate({
        source: parsed.descriptor.template!.content,
        filename: file,
        id: `select-form-${mode}`,
        ssr: true,
        ssrCssVars: [],
        compilerOptions: { bindingMetadata: serverScript.bindings ?? {} },
      });
      assert.deepEqual(serverTemplate.errors, []);
      await writeFile(file.replace(/\.vue$/, ".ssr.ts"), `${serverScript.content.replace("export default", "const Component =")}
${serverTemplate.code}
export default Object.assign(Component, { ssrRender });
`);
      const entry = join(outDirectory, "entry.ts");
      const bundle = join(outDirectory, "vue.js");
      await writeFile(entry, `import { createApp, h } from "vue";
import { XChoice } from "./vue/${mode === "application" ? "application" : "index"}";
createApp({ render: () => [h("form", { id: "owner" }, h("button", { type: "submit" }, "Send")), h(XChoice, { id: "case", form: "owner" })] }).mount(document.querySelector("main"));\n`);
      await build({
        entryPoints: [entry], outfile: bundle, bundle: true, format: "iife", platform: "browser", target: ["es2022"], nodePaths: [nodeModulesPath],
        plugins: [{ name: "compiled-vue-sfc", setup(pluginBuild) {
          pluginBuild.onResolve({ filter: /\.vue$/ }, (args) => ({ path: resolve(args.resolveDir, args.path.replace(/\.vue$/, ".ts")) }));
        } }],
      });
      const hydrateEntry = join(outDirectory, "hydrate.ts");
      const hydrate = join(outDirectory, "hydrate.js");
      await writeFile(hydrateEntry, `import { createSSRApp, h } from "vue";
import { XChoice } from "./vue/${mode === "application" ? "application" : "index"}";
createSSRApp({ render: () => [h("form", { id: "owner" }, h("button", { type: "submit" }, "Send")), h(XChoice, { id: "case", form: "owner" })] }).mount(document.querySelector("main"));\n`);
      await build({
        entryPoints: [hydrateEntry], outfile: hydrate, bundle: true, format: "iife", platform: "browser", target: ["es2022"], nodePaths: [nodeModulesPath],
        plugins: [{ name: "compiled-vue-sfc", setup(pluginBuild) {
          pluginBuild.onResolve({ filter: /\.vue$/ }, (args) => ({ path: resolve(args.resolveDir, args.path.replace(/\.vue$/, ".ts")) }));
        } }],
      });
      const serverEntry = join(outDirectory, "server.ts");
      await writeFile(serverEntry, `import { createSSRApp, h } from "vue";
import { renderToString } from "@vue/server-renderer";
import { XChoice } from "./vue/${mode === "application" ? "application" : "index"}";
export const render = () => renderToString(createSSRApp({ render: () => [h("form", { id: "owner" }, h("button", { type: "submit" }, "Send")), h(XChoice, { id: "case", form: "owner" })] }));\n`);
      const serverBuild = await build({
        entryPoints: [serverEntry], bundle: true, format: "esm", platform: "node", write: false, nodePaths: [nodeModulesPath],
        plugins: [{ name: "compiled-vue-sfc-ssr", setup(pluginBuild) {
          pluginBuild.onResolve({ filter: /\.vue$/ }, (args) => ({ path: resolve(args.resolveDir, args.path.replace(/\.vue$/, ".ssr.ts")) }));
        } }],
      });
      const serverModule = await import(`data:text/javascript;base64,${Buffer.from(serverBuild.outputFiles[0]!.text).toString("base64")}`);
      const server = await serverModule.render() as string;
      converted.set(mode, { client: bundle, hydrate, server });
    }
  });

  afterAll(async () => { if (directory !== "") await rm(directory, { recursive: true, force: true }); });

  for (const mode of ["application", "library"] as const) {
    for (const [engine, browserType] of [["Chromium", chromium], ["Firefox", firefox], ["WebKit", webkit]] as const satisfies ReadonlyArray<readonly [string, BrowserType]>) {
      it(`${engine} ${mode} preserves external select ownership, selection, validation, and reset after hydration`, async () => {
        const browser = await browserType.launch({ headless: true });
        const [live, vue, hydrated, liveServer] = await Promise.all([browser.newPage(), browser.newPage(), browser.newPage(), browser.newPage()]);
        const pages = [live, vue, hydrated];
        const errors: string[] = [];
        const warnings: string[] = [];
        try {
          for (const page of pages) page.on("pageerror", (error) => errors.push(error.message));
          hydrated.on("console", (message) => { if (message.type() === "warning") warnings.push(message.text()); });
          await live.setContent(`${source}<main>${invocation}</main>`);
          await live.addScriptTag({ path: liveBundle });
          await live.evaluate(() => window.HtmlRuntime.lowerDocument());
          await vue.setContent("<main></main>");
          const output = converted.get(mode)!;
          await vue.addScriptTag({ path: output.client });
          const serializedLive = await live.evaluate(() =>
            (window.HtmlRuntime as typeof window.HtmlRuntime & { serializeRenderedForm(container: Element): string })
              .serializeRenderedForm(document.querySelector("main")!));
          await liveServer.setContent(`<main>${serializedLive}</main>`);
          await hydrated.setContent(`<main>${output.server}</main>`);
          await Promise.all([liveServer, hydrated].map((page) => page.evaluate(() => {
            window.selectFormTrace = { invalid: 0, submits: [] };
          })));
          const [serverLive, serverHydrated] = await Promise.all([snapshot(liveServer), snapshot(hydrated)]);
          assert.deepEqual(serverHydrated.behavior, serverLive.behavior, "server-rendered select behavior differs");
          assert.deepEqual(serverHydrated.pixels, serverLive.pixels, "server-rendered select pixels differ");
          await hydrated.addScriptTag({ path: output.hydrate });
          await Promise.all(pages.map((page) => page.evaluate(() => {
            window.selectFormTrace = { invalid: 0, submits: [] };
            const form = document.querySelector<HTMLFormElement>("#owner")!;
            document.querySelector("#case")!.addEventListener("invalid", () => { window.selectFormTrace.invalid += 1; });
            form.addEventListener("submit", (event) => {
              event.preventDefault();
              window.selectFormTrace.submits.push(Array.from(new FormData(form), ([name, value]) => [name, String(value)] as [string, string]));
            });
          })));
          const compare = async (stage: string) => {
            const [actualLive, actualVue, actualHydrated] = await Promise.all([snapshot(live), snapshot(vue), snapshot(hydrated)]);
            assert.deepEqual(actualVue.behavior, actualLive.behavior, `${stage} form behavior differs`);
            assert.deepEqual(actualVue.pixels, actualLive.pixels, `${stage} form pixels differ`);
            assert.deepEqual(actualHydrated.behavior, actualLive.behavior, `${stage} hydrated form behavior differs`);
            assert.deepEqual(actualHydrated.pixels, actualLive.pixels, `${stage} hydrated form pixels differ`);
            return actualLive.behavior;
          };
          const initial = await compare("initial");
          assert.equal(initial.tag, "select");
          assert.equal(initial.owner, "owner");
          assert.equal(initial.inElements, true);
          assert.equal(initial.value, "b");
          assert.deepEqual(initial.data, [["choice", "b"]]);

          for (const page of pages) await page.locator("#case").selectOption("");
          const empty = await compare("required selection cleared");
          assert.equal(empty.valueMissing, true);
          assert.equal(empty.current, "");
          for (const page of pages) await page.evaluate(() => document.querySelector<HTMLFormElement>("#owner")!.requestSubmit());
          const rejected = await compare("invalid submission");
          assert.deepEqual(rejected.submits, []);
          assert.equal(rejected.invalidEvents, 1);

          for (const page of pages) await page.locator("#case").selectOption("a");
          for (const page of pages) await page.evaluate(() => document.querySelector<HTMLFormElement>("#owner")!.requestSubmit());
          const accepted = await compare("valid submission");
          assert.deepEqual(accepted.data, [["choice", "a"]]);
          assert.deepEqual(accepted.submits, [[["choice", "a"]]]);

          for (const page of pages) await page.evaluate(() => document.querySelector<HTMLFormElement>("#owner")!.reset());
          const reset = await compare("native reset");
          assert.equal(reset.value, "a");
          assert.deepEqual(warnings.filter((message) => !message.startsWith("Feature flags ") && /hydration|mismatch/i.test(message)), [], "Vue reported a hydration mismatch");
          assert.deepEqual(errors, []);
        } finally {
          await Promise.all([...pages, liveServer].map((page) => page.close()));
          await browser.close();
        }
      });
    }
  }
});

declare global {
  interface Window {
    HtmlRuntime: { lowerDocument(): void };
    selectFormTrace: { invalid: number; submits: Array<Array<[string, string]>> };
  }
}
