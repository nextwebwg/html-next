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
const definitions = {
  self: `<template component="x-self-cycle" status="early" summary="Self cycle."><defs><computed name="loop" from="loop + 1"></computed></defs><div from:data-value="loop"></div></template>`,
  mutual: `<template component="x-mutual-cycle" status="early" summary="Mutual cycle."><defs><computed name="left" from="right + 1"></computed><computed name="right" from="left + 1"></computed></defs><div from:data-value="left"></div></template>`,
} as const;

type Diagnostic = { readonly name: string; readonly code: string | null; readonly message: string };

describe.skipIf(!enabled)("public Vue converter computed-cycle diagnostic parity", () => {
  let directory = "";
  let liveBundle = "";
  const converted = new Map<ConversionGraph, string>();

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-vue-computed-cycle-"));
    await mkdir(join(directory, "components"));
    await writeFile(join(directory, "components", "self.html"), definitions.self);
    await writeFile(join(directory, "components", "mutual.html"), definitions.mutual);
    liveBundle = join(directory, "live.js");
    await build({ entryPoints: [livePath], outfile: liveBundle, bundle: true, format: "iife", globalName: "HtmlRuntime", platform: "browser", target: ["es2022"] });

    for (const mode of ["application", "library"] as const) {
      const outDirectory = join(directory, mode);
      const manifest = await convertComponents({ mode, target: "vue", entries: ["components/self.html", "components/mutual.html"], root: directory, outDirectory });
      assert.deepEqual(manifest.components.map((component) => component.tag).sort(), ["x-mutual-cycle", "x-self-cycle"]);
      for (const component of manifest.components) {
        const file = join(outDirectory, component.artifact);
        const parsed = parseVue(await readFile(file, "utf8"), { filename: file });
        assert.deepEqual(parsed.errors, []);
        await writeFile(file.replace(/\.vue$/, ".ts"), compileScript(parsed.descriptor, { id: `cycle-${mode}-${component.name}`, inlineTemplate: true }).content);
      }
      const entry = join(outDirectory, "entry.ts");
      const bundle = join(outDirectory, "vue.js");
      await writeFile(entry, `import { createApp, h } from "vue";
import { XSelfCycle, XMutualCycle } from "./vue/${mode === "application" ? "application" : "index"}";
const Component = window.cycleKind === "self" ? XSelfCycle : XMutualCycle;
const app = createApp({ render: () => h(Component, { id: "case" }) });
app.config.errorHandler = (error) => {
  window.vueCycleDiagnostic = { name: error.name, code: error.diagnostic?.code ?? null, message: error.message };
};
app.mount(document.querySelector("main"));
`);
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
    for (const kind of ["self", "mutual"] as const) {
      for (const [engine, browserType] of [["Chromium", chromium], ["Firefox", firefox], ["WebKit", webkit]] as const satisfies ReadonlyArray<readonly [string, BrowserType]>) {
        it(`${engine} ${mode} reports HR006 for a ${kind} cycle`, async () => {
          const browser = await browserType.launch({ headless: true });
          const [live, vue] = await Promise.all([browser.newPage(), browser.newPage()]);
          try {
            const tag = kind === "self" ? "x-self-cycle" : "x-mutual-cycle";
            await live.setContent(`${definitions.self}${definitions.mutual}<main><${tag} id="case"></${tag}></main>`);
            await live.addScriptTag({ path: liveBundle });
            const liveDiagnostic = await live.evaluate((): Diagnostic | null => {
              try { window.HtmlRuntime.lowerDocument(); return null; }
              catch (error) {
                const value = error as Error & { diagnostic?: { code?: string } };
                return { name: value.name, code: value.diagnostic?.code ?? null, message: value.message };
              }
            });
            await vue.setContent("<main></main>");
            await vue.evaluate((value) => { window.cycleKind = value; }, kind);
            await vue.addScriptTag({ path: converted.get(mode)! });
            const vueDiagnostic = await vue.evaluate(() => window.vueCycleDiagnostic ?? null);
            const expected: Diagnostic = { name: "HtmlDiagnosticError", code: "HR006", message: "HR006: A reactive computed value depends on itself." };
            assert.deepEqual(liveDiagnostic, expected);
            assert.deepEqual(vueDiagnostic, expected);
          } finally {
            await Promise.all([live.close(), vue.close()]);
            await browser.close();
          }
        });
      }
    }
  }
});

declare global {
  interface Window {
    cycleKind: "self" | "mutual";
    vueCycleDiagnostic?: Diagnostic;
  }
}
