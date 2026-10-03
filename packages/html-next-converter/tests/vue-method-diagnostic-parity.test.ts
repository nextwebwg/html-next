import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";

import { compileScript, parse as parseVue } from "@vue/compiler-sfc";
import { build } from "esbuild";
import { chromium, firefox, webkit, type BrowserType } from "playwright";

import { convertComponents, type ConversionGraph } from "../src/index.js";

const enabled = process.env.HTMLNEXT_TARGET_TEST === "1";
const nodeModulesPath = new URL("../../html-next/node_modules", import.meta.url).pathname;
const livePath = new URL("../../html-next/src/live.ts", import.meta.url).pathname;
import { methodReadinessSource as source } from "./fixtures/method-readiness.js";

type Failure = { readonly name: string; readonly code: string | null; readonly message: string };

describe.skipIf(!enabled)("public Vue converter method-without-controller parity", () => {
  let directory = "";
  let liveBundle = "";
  const converted = new Map<ConversionGraph, string>();

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-vue-method-diagnostic-"));
    await mkdir(join(directory, "components"));
    await writeFile(join(directory, "components", "no-controller.html"), source);
    liveBundle = join(directory, "live.js");
    await build({ entryPoints: [livePath], outfile: liveBundle, bundle: true, format: "iife", globalName: "HtmlRuntime", platform: "browser", target: ["es2022"] });

    for (const mode of ["application", "library"] as const) {
      const outDirectory = join(directory, mode);
      const manifest = await convertComponents({ mode, target: "vue", entries: ["components/no-controller.html"], root: directory, outDirectory });
      assert.deepEqual(manifest.components.map((component) => component.tag), ["x-no-controller"]);
      const file = join(outDirectory, manifest.components[0]!.artifact);
      const parsed = parseVue(await readFile(file, "utf8"), { filename: file });
      assert.deepEqual(parsed.errors, []);
      await writeFile(file.replace(/\.vue$/, ".ts"), compileScript(parsed.descriptor, { id: `method-diagnostic-${mode}`, inlineTemplate: true }).content);
      const entry = join(outDirectory, "entry.ts");
      const bundle = join(outDirectory, "vue.js");
      await writeFile(entry, `import { createApp, h, ref } from "vue";
import { XNoController } from "./vue/${mode === "application" ? "application" : "index"}";
const instance = ref(null);
window.vueNoControllerMethod = () => instance.value.ping();
createApp({ render: () => h(XNoController, { id: "case", ref: instance }) }).mount(document.querySelector("main"));\n`);
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
      it(`${engine} ${mode} preserves the not-ready method rejection`, async () => {
        const browser = await browserType.launch({ headless: true });
        const [live, vue] = await Promise.all([browser.newPage(), browser.newPage()]);
        try {
          await live.setContent(`${source}<main><x-no-controller id="case"></x-no-controller></main>`);
          await live.addScriptTag({ path: liveBundle });
          await live.evaluate(() => window.HtmlRuntime.lowerDocument());
          await vue.setContent("<main></main>");
          await vue.addScriptTag({ path: converted.get(mode)! });
          assert.equal(await live.locator("#case").textContent(), "Ping");
          assert.equal(await vue.locator("#case").textContent(), "Ping");
          assert.deepEqual(await vue.locator("#case").screenshot(), await live.locator("#case").screenshot());
          const liveFailure = await live.evaluate(async (): Promise<Failure | null> => {
            try { await (document.querySelector("#case") as Element & { ping(): Promise<void> }).ping(); return null; }
            catch (error) { const value = error as Error & { diagnostic?: { code?: string } }; return { name: value.name, code: value.diagnostic?.code ?? null, message: value.message }; }
          });
          const vueFailure = await vue.evaluate(async (): Promise<Failure | null> => {
            try { await window.vueNoControllerMethod(); return null; }
            catch (error) { const value = error as Error & { diagnostic?: { code?: string } }; return { name: value.name, code: value.diagnostic?.code ?? null, message: value.message }; }
          });
          assert.deepEqual(liveFailure, {
            name: "TypeError", code: null, message: "Controller method `ping` is not ready for <x-no-controller>.",
          });
          assert.deepEqual(vueFailure, liveFailure);
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
    HtmlRuntime: { lowerDocument(): void };
    vueNoControllerMethod: () => Promise<void>;
  }
}
