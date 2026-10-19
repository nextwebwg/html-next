import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, it } from "vitest";

import { compileScript, parse as parseVue } from "@vue/compiler-sfc";
import { build, type BuildOptions } from "esbuild";
import { chromium } from "playwright";

import { generateComponent, loadNodeComponents } from "@nextwebwg/html-next";
import { convertComponents } from "../src/index.js";
import { sveltePlugin } from "./helpers/svelte.js";

/**
 * Prop inputs every target reads the same way: a bound component prop inside `$each` reads the row
 * (and the converted Vue output type-checks), a bare boolean attribute is true, and an optional
 * object field that is null is a missing one (https://nextwebwg.org/declarative-components/types#null-and-missing-values).
 * Run in the live runtime, compiled Vanilla output and converted Vue, React and Svelte components.
 */
const enabled = process.env.HTMLNEXT_TARGET_TEST === "1";
const nodeModules = fileURLToPath(new URL("../node_modules", import.meta.url));
const htmlNextSource = fileURLToPath(new URL("../../html-next/src/", import.meta.url));
const run = promisify(execFile);

const source = `<template component="x-row" status="early" summary="Row."><defs><prop name="selected" type="boolean" default="false">S.</prop></defs><div class="row" from:data-selected="$selected"><slot></slot></div></template>
<template component="x-list" status="early" summary="List."><defs><prop name="rows" type="list(object({ id: string }))">R.</prop><prop name="selected" type="string" default="">S.</prop></defs><div class="list"><x-row $each="r of $rows" $key="$r.id" from:selected="$r.id = $selected">{$r.id}</x-row></div></template>
<template component="x-flag" status="early" summary="Flag." controller="./flag.js"><defs><prop name="decorative" type="boolean" default="false">D.</prop></defs><span class="flag" from:data-decorative="$decorative"></span></template>
<template component="x-geometry" status="early" summary="Geometry."><defs><prop name="geometry" type="object({ active: object({ row: integer }), hovered?: object({ row: integer }) })">G.</prop></defs><p class="geometry" from:data-active="$geometry.active.row" from:data-hovered="$geometry.hovered.row"></p></template>`;
const flag = `export default function initialize(host) { host.on("connect", () => { globalThis.decorative = host.props.decorative.value; }); }`;
const rows = [{ id: "a" }, { id: "b" }];
const geometry = { active: { row: 1 }, hovered: null };
const wrong = { active: { row: 1 }, hovered: 5 };
const vuePlugin = { name: "compiled-vue-sfc", setup(pluginBuild: { onResolve: (options: { filter: RegExp }, callback: (args: { path: string; resolveDir: string }) => { path: string }) => void }) {
  pluginBuild.onResolve({ filter: /\.vue$/ }, (args) => ({ path: resolve(args.resolveDir, args.path.replace(/\.vue$/, ".ts")) }));
} };
const emptyStyles = { name: "empty-styles", setup(pluginBuild: { onResolve: (options: { filter: RegExp }, callback: (args: { path: string }) => { path: string; namespace: string }) => void; onLoad: (options: { filter: RegExp; namespace: string }, callback: () => { contents: string; loader: "js" }) => void }) {
  pluginBuild.onResolve({ filter: /\.css$/ }, (args) => ({ path: args.path, namespace: "empty-style" }));
  pluginBuild.onLoad({ filter: /.*/, namespace: "empty-style" }, () => ({ contents: "", loader: "js" }));
} };

type Target = "live" | "vanilla" | "vue" | "react" | "svelte";

/** Compiles an SFC to the module the bundle imports in its place. */
async function compileVueFile(path: string, id: string): Promise<void> {
  const parsed = parseVue(await readFile(path, "utf8"), { filename: path });
  assert.deepEqual(parsed.errors, []);
  await writeFile(path.replace(/\.vue$/, ".ts"), compileScript(parsed.descriptor, { id, inlineTemplate: true }).content);
}

describe.skipIf(!enabled)("prop inputs in every target", () => {
  let directory = "";
  const bundles = new Map<Target, string>();

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-prop-inputs-"));
    await symlink(nodeModules, join(directory, "node_modules"), "dir");
    const app = join(directory, "app");
    await mkdir(app);
    await writeFile(join(app, "inputs.html"), source);
    await writeFile(join(app, "flag.js"), flag);
    const browserBuild: BuildOptions = { bundle: true, format: "iife", platform: "browser", target: ["es2022"], jsx: "automatic", nodePaths: [nodeModules], loader: { ".css": "empty" } };
    const data = `const rows = ${JSON.stringify(rows)}; const geometry = ${JSON.stringify(geometry)}; const wrong = ${JSON.stringify(wrong)};`;

    await writeFile(join(app, "live-entry.ts"), `import { startBrowserComponents } from ${JSON.stringify(join(htmlNextSource, "browser-loader.ts"))};
import { componentRegistry } from ${JSON.stringify(join(htmlNextSource, "runtime.ts"))};
${data}
document.querySelector("#mount")!.innerHTML = '<link rel="component" href="/inputs.html"><x-list></x-list><x-flag decorative></x-flag><x-geometry></x-geometry><x-geometry id="wrong"></x-geometry>';
startBrowserComponents();
const supply = () => {
  const list = document.querySelector(".list"), shape = document.querySelector(".geometry:not(#wrong)"), invalid = document.querySelector("#wrong");
  if (list === null || shape === null || invalid === null) return requestAnimationFrame(supply);
  componentRegistry.update(list, { rows, selected: "b" });
  componentRegistry.update(shape, { geometry });
  componentRegistry.update(invalid, { geometry: wrong });
};
supply();`);
    await build({ ...browserBuild, entryPoints: [join(app, "live-entry.ts")], outfile: join(directory, "live.js") });
    bundles.set("live", join(directory, "live.js"));

    // Compiled Vanilla modules beside their source, so a component's import of another resolves.
    const graph = await loadNodeComponents([pathToFileURL(join(app, "inputs.html")).href]);
    const invocations = new Map([...graph.nodes.values()].map((node) => [node.definition.contract.tag,
      { module: `./${node.definition.contract.name}.js`, definition: node.definition }]));
    for (const node of graph.nodes.values()) {
      const module = generateComponent(node.definition, { invocations }).find((artifact) => artifact.path === `vanilla/${node.definition.contract.name}.js`)!;
      await writeFile(join(app, `${node.definition.contract.name}.js`), module.content);
    }
    await writeFile(join(app, "vanilla-entry.ts"), `import { createXList } from "./XList.js"; import { createXFlag } from "./XFlag.js"; import { createXGeometry } from "./XGeometry.js";
${data}
document.querySelector("#mount")!.append(createXList({ rows, selected: "b" }), createXFlag({ decorative: true }), createXGeometry({ geometry }), createXGeometry({ geometry: wrong, attributes: { id: "wrong" } }));`);
    await build({ ...browserBuild, entryPoints: [join(app, "vanilla-entry.ts")], outfile: join(directory, "vanilla.js"), plugins: [emptyStyles],
      define: { "import.meta.url": JSON.stringify("https://app.example/inputs.js") },
      alias: { "@nextwebwg/html-next/generated-runtime": join(htmlNextSource, "generated-runtime.ts") } });
    bundles.set("vanilla", join(directory, "vanilla.js"));

    for (const target of ["vue", "react", "svelte"] as const) {
      const out = join(app, target);
      const manifest = await convertComponents({ mode: "application", target, root: app, outDirectory: out, entries: ["inputs.html"] });
      const artifact = (tag: string): string => manifest.components.find((component) => component.tag === tag)!.artifact;
      const entryPath = join(out, target === "react" ? "entry.tsx" : "entry.ts");
      if (target === "vue") {
        // vue-tsc checks the generated components as an application's build does.
        await writeFile(join(out, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler",
          strict: true, skipLibCheck: true, noEmit: true, allowImportingTsExtensions: true, lib: ["ES2022", "DOM", "DOM.Iterable"] }, files: manifest.components.map((component) => component.artifact) }));
        try { await run(join(nodeModules, ".bin/vue-tsc"), ["-p", join(out, "tsconfig.json")], { cwd: out }); }
        catch (error) { assert.fail((error as { stdout?: string }).stdout || String(error)); }
        for (const component of manifest.components) await compileVueFile(join(out, component.artifact), component.tag);
        // An application's own template, where Vue passes a bare attribute as "".
        await writeFile(join(out, "App.vue"), `<script setup lang="ts">
import XList from "./${artifact("x-list")}"; import XFlag from "./${artifact("x-flag")}"; import XGeometry from "./${artifact("x-geometry")}";
${data}
</script>
<template><XList :rows="rows" selected="b" /><XFlag decorative /><XGeometry :geometry="geometry" /><XGeometry id="wrong" :geometry="wrong as any" /></template>`);
        await compileVueFile(join(out, "App.vue"), "app");
        await writeFile(entryPath, `import { createApp } from "vue"; import App from "./App.vue"; createApp(App).mount("#mount");`);
      } else if (target === "react") {
        await writeFile(entryPath, `import { createRoot } from "react-dom/client";
import XList from "./${artifact("x-list")}"; import XFlag from "./${artifact("x-flag")}"; import XGeometry from "./${artifact("x-geometry")}";
${data}
createRoot(document.querySelector("#mount")!).render(<><XList rows={rows} selected="b" /><XFlag decorative /><XGeometry geometry={geometry as any} /><XGeometry id="wrong" geometry={wrong as any} /></>);`);
      } else {
        await writeFile(join(out, "App.svelte"), `<script lang="ts">
  import XList from "./${artifact("x-list")}"; import XFlag from "./${artifact("x-flag")}"; import XGeometry from "./${artifact("x-geometry")}";
  ${data}
</script>
<XList {rows} selected="b" /><XFlag decorative /><XGeometry geometry={geometry as any} /><XGeometry id="wrong" geometry={wrong as any} />`);
        await writeFile(entryPath, `import { mount } from "svelte"; import App from "./App.svelte"; mount(App, { target: document.querySelector("#mount")! });`);
      }
      await build({ ...browserBuild, entryPoints: [entryPath], outfile: join(directory, `${target}.js`),
        plugins: target === "vue" ? [vuePlugin] : target === "svelte" ? [sveltePlugin("client")] : [] });
      bundles.set(target, join(directory, `${target}.js`));
    }
  }, 180_000);
  afterAll(async () => { if (directory !== "") await rm(directory, { recursive: true, force: true }); });

  for (const target of ["live", "vanilla", "vue", "react", "svelte"] as const) {
    it(`${target} reads a row's bound prop, a bare boolean attribute as true, and a null optional field as missing`, async () => {
      const browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage();
        const errors: string[] = [];
        const warnings: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        page.on("console", (message) => {
          if (message.type() === "error") errors.push(message.text());
          if (message.type() === "warning") warnings.push(message.text());
        });
        await page.route("https://app.example/**", async (route) => {
          const url = new URL(route.request().url());
          if (url.pathname === "/inputs.html") return route.fulfill({ contentType: "text/html", body: source });
          if (url.pathname === "/flag.js") return route.fulfill({ contentType: "text/javascript", body: flag });
          return route.fulfill({ contentType: "text/html", body: '<!doctype html><body><div id="mount"></div></body>' });
        });
        await page.goto("https://app.example/");
        await page.addScriptTag({ path: bundles.get(target)! });
        await page.waitForFunction(() => document.querySelectorAll(".row").length === 2 && (globalThis as { decorative?: unknown }).decorative !== undefined
          && document.querySelector(".geometry:not(#wrong)")?.hasAttribute("data-active") && document.querySelector("#wrong") !== null, undefined, { timeout: 10_000 });
        const result = await page.evaluate(() => ({
          rows: Array.from(document.querySelectorAll(".row"), (row) => [row.textContent, row.hasAttribute("data-selected")]),
          decorative: [(globalThis as { decorative?: unknown }).decorative, document.querySelector(".flag")!.hasAttribute("data-decorative")],
          geometry: [document.querySelector(".geometry:not(#wrong)")!.getAttribute("data-active"), document.querySelector(".geometry:not(#wrong)")!.getAttribute("data-hovered")],
          // A field of the wrong type rejects the prop, which reports itself invalid rather than going quiet.
          wrong: [document.querySelector("#wrong")!.getAttribute("aria-invalid"), document.querySelector("#wrong")!.hasAttribute("data-active")],
        }));
        assert.deepEqual(result, { rows: [["a", false], ["b", true]], decorative: [true, true], geometry: ["1", null], wrong: ["true", false] });
        assert.deepEqual(warnings.filter((warning) => warning.includes("HR007")), []);
        assert.deepEqual(errors, []);
      } finally { await browser.close(); }
    });
  }
});
