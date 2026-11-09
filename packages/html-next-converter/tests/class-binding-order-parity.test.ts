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

const source = `<template component="x-page"><defs>
<state name="text" type="string" value="first"></state><state name="active" type="boolean" value="true"></state><state name="zero" type="number" value="1"></state>
<state name="rows" type="list(object({ label: string, active: boolean }))" from="[{ label: 'a', active: true }, { label: 'b', active: false }]"></state>
<handler name="next"><set name="text" value="second"></set><set name="rows" expr:value="[{ label: 'b', active: false }, { label: 'a', active: true }]"></set></handler>
<handler name="off"><set name="active" value="false"></set></handler>
<handler name="on"><set name="active" value="true"></set></handler>
<handler name="invalid"><set name="zero" value="0"></set></handler>
<handler name="recover"><set name="text" value="third"></set><set name="zero" value="1"></set></handler>
</defs><main id="page" class="root root" class:running="$active">
<b id="before" class=" literal  literal " class:active="$active" from:class="$zero = 0 ? 1 / 0 : $text"></b>
<i id="after" class=" literal  literal " from:class="$zero = 0 ? 1 / 0 : $text" class:active="$active"></i>
<em id="overlap" class="active" from:class="'base'" class:active="true"></em>
<strong id="constant-first" class:active="true" from:class="$text"></strong>
<s id="literal" class=" raw  raw " class:active="$active"></s>
<section id="rows"><p $each="row of $rows" $key="$row.label" from:data-row="$row.label" class=" row  row " class:selected="$row.active and $active">{$row.label}</p></section>
<button id="next" on:click="next">Next</button><button id="off" on:click="off">Off</button><button id="on" on:click="on">On</button><button id="invalid" on:click="invalid">Invalid</button><button id="recover" on:click="recover">Recover</button>
</main></template>`;
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
 describe.skipIf(!enabled)(`class binding order in ${target}`, () => {
  let directory = "";
  const bundles = new Map<string, string>();
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-classes-"));
    await symlink(nodeModules, join(directory, "node_modules"), "dir");
    await writeFile(join(directory, "page.html"), source);
    const definition = parseComponentResource(source, `file://${join(directory, "page.html")}`).definitions[0]!;
    if(target === "vanilla") {
      const module = generateComponent(definition).find(artifact => artifact.path === "vanilla/XPage.js")!;
      await writeFile(join(directory, "XPage.js"), module.content.replaceAll("import.meta.url", JSON.stringify(`file://${join(directory, "XPage.js")}`)));
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
      it(`${engine} ${mode} preserves authored order and unrelated native edits`, async () => {
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
          await page.waitForSelector("#overlap", { state: "attached" });
          const classes = () => page.evaluate(() => ["before","after","overlap","constant-first","literal"].map(id => document.getElementById(id)!.getAttribute("class")));
          const rows = () => page.evaluate(() => Array.from(document.querySelectorAll("#rows p"), row => [row.getAttribute("data-row"), row.getAttribute("class")]));
          const rootClass = () => page.locator("#page").getAttribute("class");
          const settle = () => page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
          assert.deepEqual(await classes(), ["first","first active","base active","first","raw active"]);
          assert.deepEqual(await rows(), [["a", "row selected"], ["b", " row  row "]]);
          assert.equal(await rootClass(), "root running");
          await page.evaluate(() => {
            document.getElementById("literal")!.classList.add("manual");
            document.querySelector('[data-row="a"]')!.classList.add("manual");
            document.getElementById("page")!.classList.add("external");
          });
          await page.click("#next"); await settle();
          assert.deepEqual(await classes(), ["second","second active","base active","second","raw active manual"]);
          assert.deepEqual(await rows(), [["b", " row  row "], ["a", "row selected manual"]]);
          assert.equal(await rootClass(), "root running external");
          await page.click("#off"); await settle();
          assert.deepEqual(await classes(), ["second","second","base active","second","raw manual"]);
          assert.deepEqual(await rows(), [["b", " row  row "], ["a", "row manual"]]);
          // The root replays its authored whole class before its changed keyed write.
          assert.equal(await rootClass(), "root root");
          await page.click("#on"); await settle();
          assert.deepEqual(await classes(), ["second","second active","base active","second","raw manual active"]);
          assert.deepEqual(await rows(), [["b", " row  row "], ["a", "row manual selected"]]);
          assert.equal(await rootClass(), "root running");
          await page.click("#invalid"); await settle();
          assert.deepEqual(await classes(), ["second","second active","base active","second","raw manual active"]);
          await page.click("#recover"); await settle();
          assert.deepEqual(await classes(), ["third","third active","base active","third","raw manual active"]);
          assert.deepEqual(await rows(), [["b", " row  row "], ["a", "row manual selected"]]);
          assert.equal(await rootClass(), "root running");
          assert.deepEqual(errors, []);
        } finally { await browser.close(); }
      });
    }
  }
 });
}
