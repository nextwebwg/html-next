import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, it } from "vitest";

import { compileScript, parse as parseVue } from "@vue/compiler-sfc";
import { build, type BuildOptions } from "esbuild";
import { chromium, firefox, webkit, type Page } from "playwright";

import { generateComponent, loadNodeComponents } from "@nextwebwg/html-next";
import { convertComponents } from "../src/index.js";
import { sveltePlugin } from "./helpers/svelte.js";

/**
 * `<template $slot>` is the parser-safe slot outlet
 * (https://nextwebwg.org/declarative-components/components#parser-safe-outlets): the HTML parser
 * moves a `<slot>` written directly in a table section or row out to before the `<table>`, and leaves
 * a `<template>` in place. A table component slots its consumer's `<tr>` rows through
 * `<template $slot="row">` in `<tbody>` and header cells through `<template $slot>` in `<thead><tr>`,
 * and shows each outlet's fallback without a consumer. Run in the live runtime, which parses the
 * definition with the browser's own parser, compiled Vanilla output and converted Vue, React and
 * Svelte components, in Chromium, Firefox and WebKit.
 */
const enabled = process.env.HTMLNEXT_TARGET_TEST === "1";
const nodeModules = fileURLToPath(new URL("../node_modules", import.meta.url));
const htmlNextSource = fileURLToPath(new URL("../../html-next/src/", import.meta.url));

const component = (tag: string, body: string): string => `<template component="${tag}" status="early" summary="${tag}.">${body}</template>`;
const source = [
  component("x-grid", `<defs><prop name="rows" type="list(string)" default="['Ada', 'Bea']">The rows.</prop>
<slot name="row"><prop name="item" type="string" required>The row.</prop></slot></defs>
<table><thead><tr><template $slot><th class="head">Name</th></template></tr></thead>
<tbody><template $slot="row" $each="row of $rows" $key="$row" from:item="$row"><tr><td class="cell">{$row}</td></tr></template></tbody></table>`),
  component("x-app", `<defs><state name="rows" type="list(string)" value="['Ada', 'Bea']"></state>
<handler name="change"><set name="rows" expr:value="['Cy', 'Ada']"></set></handler></defs>
<main><button type="button" class="change" on:click="change">Change</button>
<x-grid from:rows="$rows"><template slot=""><th class="head">Who</th><th class="head">#</th></template>
<template slot="row"><tr><td class="cell">{$item}</td><td class="cell">{$item}!</td></tr></template></x-grid>
<x-grid from:rows="$rows"></x-grid></main>`),
].join("\n");

const vuePlugin = { name: "compiled-vue-sfc", setup(pluginBuild: { onResolve: (options: { filter: RegExp }, callback: (args: { path: string; resolveDir: string }) => { path: string }) => void }) {
  pluginBuild.onResolve({ filter: /\.vue$/ }, (args) => ({ path: resolve(args.resolveDir, args.path.replace(/\.vue$/, ".ts")) }));
} };
const emptyStyles = { name: "empty-styles", setup(pluginBuild: { onResolve: (options: { filter: RegExp }, callback: (args: { path: string }) => { path: string; namespace: string }) => void; onLoad: (options: { filter: RegExp; namespace: string }, callback: () => { contents: string; loader: "js" }) => void }) {
  pluginBuild.onResolve({ filter: /\.css$/ }, (args) => ({ path: args.path, namespace: "empty-style" }));
  pluginBuild.onLoad({ filter: /.*/, namespace: "empty-style" }, () => ({ contents: "", loader: "js" }));
} };

type Target = "live" | "vanilla" | "vue" | "react" | "svelte";
type Tables = Array<{ before: string | null; head: string[]; rows: string[][] }>;

/** Each table's header cells and rows, and any element before it, where the HTML parser would have moved a slot. */
const READ = `Array.from(document.querySelectorAll("table"), (table) => ({
  before: table.previousElementSibling?.localName ?? null,
  head: Array.from(table.querySelectorAll(":scope > thead > tr > th"), (cell) => cell.textContent.trim()),
  rows: Array.from(table.querySelectorAll(":scope > tbody > tr"), (row) => Array.from(row.querySelectorAll(":scope > td"), (cell) => cell.textContent.trim())),
}))`;

async function tables(page: Page, expected: Tables): Promise<Tables> {
  await page.waitForFunction(`JSON.stringify(${READ}) === ${JSON.stringify(JSON.stringify(expected))}`, undefined, { timeout: 5_000 }).catch(() => {});
  return page.evaluate(READ) as Promise<Tables>;
}

describe.skipIf(!enabled)("<template $slot> outlets in table parts", () => {
  let directory = "";
  const bundles = new Map<Target, string>();

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-table-slot-"));
    await symlink(nodeModules, join(directory, "node_modules"), "dir");
    const app = join(directory, "app");
    await mkdir(app);
    await writeFile(join(app, "grid.html"), source);
    const browserBuild: BuildOptions = { bundle: true, format: "iife", platform: "browser", target: ["es2022"], jsx: "automatic", nodePaths: [nodeModules], loader: { ".css": "empty" } };

    await build({ ...browserBuild, entryPoints: [join(htmlNextSource, "browser-loader.ts")], outfile: join(directory, "live.js"), globalName: "HtmlNextLoader" });
    bundles.set("live", join(directory, "live.js"));

    // Compiled Vanilla modules beside their source, so a component's import of another resolves.
    const graph = await loadNodeComponents([pathToFileURL(join(app, "grid.html")).href]);
    const invocations = new Map([...graph.nodes.values()].map((node) => [node.definition.contract.tag,
      { module: `./${node.definition.contract.name}.js`, definition: node.definition }]));
    for (const node of graph.nodes.values()) {
      const module = generateComponent(node.definition, { invocations }).find((artifact) => artifact.path === `vanilla/${node.definition.contract.name}.js`)!;
      await writeFile(join(app, `${node.definition.contract.name}.js`), module.content);
    }
    await writeFile(join(app, "vanilla-entry.ts"), `import { createXApp } from "./XApp.js"; document.querySelector("#mount")!.append(createXApp());`);
    await build({ ...browserBuild, entryPoints: [join(app, "vanilla-entry.ts")], outfile: join(directory, "vanilla.js"), plugins: [emptyStyles],
      alias: { "@nextwebwg/html-next/generated-runtime": join(htmlNextSource, "generated-runtime.ts") } });
    bundles.set("vanilla", join(directory, "vanilla.js"));

    for (const target of ["vue", "react", "svelte"] as const) {
      const out = join(app, target);
      const manifest = await convertComponents({ mode: "application", target, root: app, outDirectory: out, entries: ["grid.html"] });
      const artifact = manifest.components.find((entry) => entry.tag === "x-app")!.artifact;
      const entry = join(out, target === "react" ? "entry.tsx" : "entry.ts");
      if (target === "vue") {
        for (const converted of manifest.components) {
          const path = join(out, converted.artifact);
          const parsed = parseVue(await readFile(path, "utf8"), { filename: path });
          assert.deepEqual(parsed.errors, [], converted.artifact);
          await writeFile(path.replace(/\.vue$/, ".ts"), compileScript(parsed.descriptor, { id: converted.tag, inlineTemplate: true }).content);
        }
        await writeFile(entry, `import { createApp, h } from "vue"; import App from "./${artifact}"; createApp({ render: () => h(App) }).mount("#mount");`);
      } else if (target === "react") {
        await writeFile(entry, `import { createRoot } from "react-dom/client"; import App from "./${artifact}"; createRoot(document.querySelector("#mount")!).render(<App />);`);
      } else {
        await writeFile(entry, `import { mount } from "svelte"; import App from "./${artifact}"; mount(App, { target: document.querySelector("#mount")! });`);
      }
      await build({ ...browserBuild, entryPoints: [entry], outfile: join(directory, `${target}.js`),
        plugins: target === "vue" ? [vuePlugin] : target === "svelte" ? [sveltePlugin("client")] : [] });
      bundles.set(target, join(directory, `${target}.js`));
    }
  }, 180_000);
  afterAll(async () => { if (directory !== "") await rm(directory, { recursive: true, force: true }); });

  for (const [engine, browserType] of [["Chromium", chromium], ["Firefox", firefox], ["WebKit", webkit]] as const) {
    for (const target of ["live", "vanilla", "vue", "react", "svelte"] as const) {
      it(`${target} slots rows and header cells into the table in ${engine}`, async () => {
        const browser = await browserType.launch({ headless: true });
        try {
          const page = await browser.newPage();
          const errors: string[] = [];
          page.on("pageerror", (error) => errors.push(error.message));
          page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
          await page.route("https://app.example/**", (route) => new URL(route.request().url()).pathname === "/grid.html"
            ? route.fulfill({ contentType: "text/html", body: source })
            : route.fulfill({ contentType: "text/html", body: target === "live"
              ? '<link rel="component" href="/grid.html"><div id="mount"><x-app></x-app></div>' : '<div id="mount"></div>' }));
          await page.goto("https://app.example/");
          await page.addScriptTag({ path: bundles.get(target)! });
          if (target === "live") {
            await page.evaluate(() => (window as unknown as { HtmlNextLoader: { startBrowserComponents(): Promise<unknown> } }).HtmlNextLoader.startBrowserComponents())
              .catch((error: unknown) => errors.push(String(error)));
          }
          const shown: Tables = [
            { before: "button", head: ["Who", "#"], rows: [["Ada", "Ada!"], ["Bea", "Bea!"]] },
            { before: "table", head: ["Name"], rows: [["Ada"], ["Bea"]] },
          ];
          assert.deepEqual({ tables: await tables(page, shown), errors }, { tables: shown, errors: [] });
          await page.locator(".change").click();
          const changed: Tables = [
            { before: "button", head: ["Who", "#"], rows: [["Cy", "Cy!"], ["Ada", "Ada!"]] },
            { before: "table", head: ["Name"], rows: [["Cy"], ["Ada"]] },
          ];
          assert.deepEqual({ tables: await tables(page, changed), errors }, { tables: changed, errors: [] });
        } finally { await browser.close(); }
      });
    }
  }
});
