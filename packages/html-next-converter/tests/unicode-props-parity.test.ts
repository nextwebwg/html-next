import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, it } from "vitest";

import { compileScript, parse as parseVue } from "@vue/compiler-sfc";
import { build as esbuild } from "esbuild";
import { chromium, firefox, webkit, type BrowserType } from "playwright";

import { generateComponent, parseComponentResource } from "@nextwebwg/html-next";
import { convertComponents } from "../src/index.js";
import { sveltePlugin } from "./helpers/svelte.js";
import { launchParityBrowser } from "../../html-next/tests/pixel-parity.js";

const source = `<template component="x-leaf"><defs>
<prop name="é" type="string" default="lower">Lower.</prop><prop name="É" type="string" default="UPPER">Upper.</prop>
</defs><button type="button" disabled from:data-é="$é" from:data-É="$É">{$é}:{$É}<slot></slot></button></template>
<template component="x-bridge"><defs><prop name="é" type="string">Lower.</prop><prop name="É" type="string">Upper.</prop></defs>
<x-leaf from:é="$é" from:É="$É"><slot></slot></x-leaf></template>
<template component="x-page"><defs>
<state name="lower" type="string" value="first"></state><state name="upper" type="string" value="FIRST"></state>
<handler name="next"><set name="lower" value="second"></set><set name="upper" value="SECOND"></set></handler>
</defs><main>
<x-leaf id="literal" é="written" É="WRITTEN"><b>Literal child</b></x-leaf>
<x-bridge id="delegated" from:é="$lower" from:É="$upper"><b>Ordinary child</b></x-bridge>
<button id="next" on:click="next">Next</button></main></template>`;
const files = { "page.html": source };
const enabled = process.env.HTMLNEXT_TARGET_TEST === "1";
const nodeModules = fileURLToPath(new URL("../node_modules", import.meta.url));
const htmlNextSource = fileURLToPath(new URL("../../html-next/src/", import.meta.url));
const modes = ["development", "production"] as const;
const vuePlugin = { name: "compiled-vue-sfc", setup(pluginBuild: { onResolve: (options: { filter: RegExp }, callback: (args: { path: string; resolveDir: string }) => { path: string }) => void }) {
  pluginBuild.onResolve({ filter: /\.vue$/ }, (args) => ({ path: resolve(args.resolveDir, args.path.replace(/\.vue$/, ".ts")) }));
} };
const emptyStyles = { name: "empty-styles", setup(pluginBuild: { onResolve: (options: { filter: RegExp }, callback: (args: { path: string }) => { path: string; namespace: string }) => void; onLoad: (options: { filter: RegExp; namespace: string }, callback: () => { contents: string; loader: "js" }) => void }) {
  pluginBuild.onResolve({ filter: /\.css$/ }, (args) => ({ path: args.path, namespace: "empty-style" }));
  pluginBuild.onLoad({ filter: /.*/, namespace: "empty-style" }, () => ({ contents: "", loader: "js" }));
} };
const build = (options: Parameters<typeof esbuild>[0], mode: (typeof modes)[number]) => esbuild({ ...options, bundle: true, format: "iife", platform: "browser", target: ["es2022"],
  minify: mode === "production", define: { "process.env.NODE_ENV": JSON.stringify(mode) }, loader: { ".css": "empty", ...options.loader } });

for (const target of ["live", "vanilla", "vue", "react", "preact", "svelte", "angular"] as const) {
 describe.skipIf(!enabled)(`non-ASCII component names in ${target}`, () => {
  let directory = "";
  const bundles = new Map<string, string>();
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-classes-"));
    await symlink(nodeModules, join(directory, "node_modules"), "dir");
    await writeFile(join(directory, "page.html"), source);
    const definitions = parseComponentResource(source, `file://${join(directory, "page.html")}`).definitions;
    if (target === "vanilla") {
      const invocations = new Map(definitions.map(definition => [definition.contract.tag, { module: `./${definition.contract.name}.js`, definition }]));
      for (const definition of definitions) {
        const module = generateComponent(definition, { invocations }).find(artifact => artifact.path === `vanilla/${definition.contract.name}.js`)!;
        await writeFile(join(directory, `${definition.contract.name}.js`), module.content.replaceAll("import.meta.url", JSON.stringify(`file://${join(directory, definition.contract.name)}.js`)));
      }
      await writeFile(join(directory, "vanilla-entry.js"), `import { createXPage } from "./XPage.js"; document.querySelector("#mount").append(createXPage());`);
    }
    const forms = new Map<string,string>();
    if(target !== "live" && target !== "vanilla") {
      const out = join(directory, target);
      const manifest = await convertComponents({ mode: "application", target, root: directory, outDirectory: out, entries: ["page.html"], publicRootURL: "/" });
      forms.set(target, target === "angular" ? manifest.output.entry : manifest.components.find((component) => component.tag === "x-page")!.artifact);
      if (target === "vue") {
        for (const component of manifest.components) {
          const path = join(out, component.artifact);
          const parsed = parseVue(await readFile(path, "utf8"), { filename: path });
          assert.deepEqual(parsed.errors, []);
          await writeFile(path.replace(/\.vue$/, ".ts"), compileScript(parsed.descriptor, { id: component.tag, inlineTemplate: true }).content);
        }
        await writeFile(join(out, "entry.ts"), `import { createApp, h } from "vue"; import Form from "./${forms.get(target)}";
createApp({ render: () => h(Form) }).mount(document.querySelector("#mount")!);\n`);
      } else if (target === "react") {
        await writeFile(join(out, "entry.tsx"), `import { createRoot } from "react-dom/client"; import Form from "./${forms.get(target)}";
createRoot(document.querySelector("#mount")!).render(<Form />);\n`);
      } else if (target === "preact") {
        await writeFile(join(out, "entry.tsx"), `import { h, render } from "preact"; import Form from "./${forms.get(target)}";
render(h(Form, {}), document.querySelector("#mount")!);\n`);
      } else if (target === "angular") {
        const app = join(out, "app.ts");
        await writeFile(app, `import { Component } from "@angular/core"; import { XPage } from "./${forms.get(target)!.replace(/\.ts$/, "")}";
@Component({ selector: "app-root", standalone: true, imports: [XPage], template: '<main x-page></main>' }) export class App {}`);
        const config = join(out, "tsconfig.json");
        await writeFile(config, JSON.stringify({ compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", strict: true, skipLibCheck: true,
          experimentalDecorators: true, rewriteRelativeImportExtensions: true, rootDir: out, outDir: join(out, "compiled"), types: [] }, angularCompilerOptions: { strictTemplates: true }, files: [app] }));
        const require = createRequire(import.meta.url);
        const ngc = join(dirname(require.resolve("@angular/compiler-cli/package.json")), "bundles/src/bin/ngc.js");
        try { await promisify(execFile)(process.execPath, [ngc, "-p", config], { cwd: out }); }
        catch (error) { assert.fail((error as { stderr?: string }).stderr ?? String(error)); }
        await writeFile(join(out, "entry.ts"), `import "@angular/compiler"; import { bootstrapApplication } from "@angular/platform-browser"; import { App } from "./compiled/app.js";
document.querySelector("#mount")!.append(document.createElement("app-root")); bootstrapApplication(App);\n`);
      } else {
        await writeFile(join(out, "entry.ts"), `import { mount } from "svelte"; import Form from "./${forms.get(target)}";
mount(Form, { target: document.querySelector("#mount")! });\n`);
      }
    }
    for (const mode of modes) {
      const bundle = (target: string) => join(directory, `${target}-${mode}.js`);
      if(target === "live") await build({ entryPoints: [join(htmlNextSource, "browser-loader.ts")], outfile: bundle("live"), globalName: "HtmlNextLoader" }, mode);
      if(target === "vanilla") await build({ entryPoints: [join(directory, "vanilla-entry.js")], outfile: bundle("vanilla"),
        alias: { "@nextwebwg/html-next/generated-runtime": join(htmlNextSource, "generated-runtime.ts") }, plugins: [emptyStyles] }, mode);
      if(target === "vue") await build({ entryPoints: [join(directory, "vue", "entry.ts")], outfile: bundle("vue"), nodePaths: [nodeModules], plugins: [vuePlugin] }, mode);
      if(target === "react") await build({ entryPoints: [join(directory, "react", "entry.tsx")], outfile: bundle("react"), jsx: "automatic", nodePaths: [nodeModules] }, mode);
      if(target === "preact") await build({ entryPoints: [join(directory, "preact", "entry.tsx")], outfile: bundle("preact"), jsx: "automatic", jsxImportSource: "preact", nodePaths: [nodeModules] }, mode);
      if(target === "angular") await build({ entryPoints: [join(directory, "angular", "entry.ts")], outfile: bundle("angular"), nodePaths: [nodeModules] }, mode);
      if(target === "svelte") await build({ entryPoints: [join(directory, "svelte", "entry.ts")], outfile: bundle("svelte"), plugins: [sveltePlugin("client")] }, mode);
      bundles.set(mode, bundle(target));
    }
  }, 240_000);
  afterAll(async () => { if (directory !== "") await rm(directory, { recursive: true, force: true }); });

  for (const [engine, browserType] of [["Chromium", chromium], ["Firefox", firefox], ["WebKit", webkit]] as const satisfies ReadonlyArray<readonly [string, BrowserType]>) {
    for (const mode of modes) {
      it(`${engine} ${mode} preserves distinct prop names through ordinary children and delegated roots`, async () => {
        const browser = await launchParityBrowser(browserType);
        const errors: string[] = [];
        try {
          const page = await browser.newPage();
          page.on("pageerror", error => errors.push(error.message));
          await page.route("https://app.example/**", route => {
            const name = new URL(route.request().url()).pathname.slice(1);
            return route.fulfill({ contentType: "text/html", body: name === "page.html" ? files[name] : target === "live"
              ? '<link rel="component" href="/page.html"><div id="mount"><x-page></x-page></div>' : '<div id="mount"></div>' });
          });
          await page.goto("https://app.example/");
          await page.addScriptTag({ path: bundles.get(mode)! });
          if(target === "live") await page.evaluate(() => (window as unknown as { HtmlNextLoader: { startBrowserComponents(): Promise<unknown> } }).HtmlNextLoader.startBrowserComponents());
          await page.waitForSelector("#delegated", { state: "attached" });
          const snapshot = () => page.evaluate(() => ["literal", "delegated"].map(id => {
            const element = document.getElementById(id)!;
            return [element.textContent, element.getAttribute("data-é"), element.getAttribute("data-É"),
              element.getAttribute("is"), element instanceof HTMLButtonElement, (element as HTMLButtonElement).disabled,
              element.children.length, element.firstElementChild?.tagName];
          }));
          assert.deepEqual(await snapshot(), [
            ["written:WRITTENLiteral child", "written", "WRITTEN", null, true, true, 1, "B"],
            ["first:FIRSTOrdinary child", "first", "FIRST", null, true, true, 1, "B"],
          ]);
          await page.evaluate(() => { (window as unknown as { ordinaryChild: Element | null }).ordinaryChild = document.querySelector("#delegated > b"); });
          await page.click("#next");
          await page.waitForFunction(() => document.getElementById("delegated")?.getAttribute("data-É") === "SECOND");
          assert.deepEqual(await snapshot(), [
            ["written:WRITTENLiteral child", "written", "WRITTEN", null, true, true, 1, "B"],
            ["second:SECONDOrdinary child", "second", "SECOND", null, true, true, 1, "B"],
          ]);
          assert.equal(await page.evaluate(() => (window as unknown as { ordinaryChild: Element | null }).ordinaryChild === document.querySelector("#delegated > b")), true);
          assert.deepEqual(errors, []);
        } finally { await browser.close(); }
      });
    }
  }
 });
}
