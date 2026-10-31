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
import { renderComponents } from "../../html-next/src/server.js";
import { convertComponents } from "../src/index.js";
import { sveltePlugin } from "./helpers/svelte.js";

/**
 * A consumer's `$each` inside content it projects into another component, where each row invokes a
 * component: rows added after the first render create their components, as rows outside projected
 * content do. Compiled output waited for a slot to place each new row's root, which no slot places,
 * so the row kept an empty, inert invocation. Run in the live runtime and compiled Vanilla output,
 * each rendered in the browser and hydrated from Node output, and in converted Vue, React and Svelte
 * components, in Chromium, Firefox and WebKit.
 */
const enabled = process.env.HTMLNEXT_TARGET_TEST === "1";
const nodeModules = fileURLToPath(new URL("../node_modules", import.meta.url));
const htmlNextSource = fileURLToPath(new URL("../../html-next/src/", import.meta.url));

const component = (tag: string, body: string): string => `<template component="${tag}" status="early" summary="${tag}.">${body}</template>`;
const source = [
  component("x-badge", `<span class="badge"><slot></slot></span>`),
  component("x-card", `<div class="card"><slot></slot></div>`),
  component("x-app", `<defs><state name="items" type="list(string)" value="['a']"></state>
<handler name="add"><set name="items" expr:value="['a', 'b', 'c']"></set></handler></defs>
<main><button type="button" class="add" on:click="add">Add</button>
<x-card><ul class="slotted"><li $each="item of $items"><x-badge>{$item}</x-badge></li></ul>
<p class="slotted-if" $if="$items.length > 1"><x-badge>more</x-badge></p></x-card>
<ul class="plain"><li $each="item of $items"><x-badge>{$item}</x-badge></li></ul></main>`),
].join("\n");

const vuePlugin = { name: "compiled-vue-sfc", setup(pluginBuild: { onResolve: (options: { filter: RegExp }, callback: (args: { path: string; resolveDir: string }) => { path: string }) => void }) {
  pluginBuild.onResolve({ filter: /\.vue$/ }, (args) => ({ path: resolve(args.resolveDir, args.path.replace(/\.vue$/, ".ts")) }));
} };
const emptyStyles = { name: "empty-styles", setup(pluginBuild: { onResolve: (options: { filter: RegExp }, callback: (args: { path: string }) => { path: string; namespace: string }) => void; onLoad: (options: { filter: RegExp; namespace: string }, callback: () => { contents: string; loader: "js" }) => void }) {
  pluginBuild.onResolve({ filter: /\.css$/ }, (args) => ({ path: args.path, namespace: "empty-style" }));
  pluginBuild.onLoad({ filter: /.*/, namespace: "empty-style" }, () => ({ contents: "", loader: "js" }));
} };

type Target = "live" | "vanilla" | "vue" | "react" | "svelte";
type Lists = Record<string, string[]>;

/** Each list's rows as their badge's text, or the markup of a row whose badge did not render. */
const READ = `Object.fromEntries([".slotted > li", ".slotted-if", ".plain > li"].map((selector) => [selector,
  Array.from(document.querySelectorAll(selector), (row) => { const badge = row.querySelector(":scope > span.badge"); return badge ? badge.textContent.trim() : row.innerHTML; })]))`;

async function lists(page: Page, expected: Lists): Promise<Lists> {
  await page.waitForFunction(`JSON.stringify(${READ}) === ${JSON.stringify(JSON.stringify(expected))}`, undefined, { timeout: 5_000 }).catch(() => {});
  return page.evaluate(READ) as Promise<Lists>;
}

describe.skipIf(!enabled)("components in rows added to an $each inside projected content", () => {
  let directory = "";
  let rendered = "";
  const bundles = new Map<Target, string>();

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-slotted-each-"));
    await symlink(nodeModules, join(directory, "node_modules"), "dir");
    const app = join(directory, "app");
    await mkdir(app);
    await writeFile(join(app, "app.html"), source);
    const browserBuild: BuildOptions = { bundle: true, format: "iife", platform: "browser", target: ["es2022"], jsx: "automatic", nodePaths: [nodeModules], loader: { ".css": "empty" } };

    await build({ ...browserBuild, entryPoints: [join(htmlNextSource, "browser-loader.ts")], outfile: join(directory, "live.js"), globalName: "HtmlNextLoader" });
    bundles.set("live", join(directory, "live.js"));

    // Compiled Vanilla modules beside their source, so a component's import of another resolves.
    const graph = await loadNodeComponents([pathToFileURL(join(app, "app.html")).href]);
    const invocations = new Map([...graph.nodes.values()].map((node) => [node.definition.contract.tag,
      { module: `./${node.definition.contract.name}.js`, definition: node.definition }]));
    for (const node of graph.nodes.values()) {
      const module = generateComponent(node.definition, { invocations, hydrate: true }).find((artifact) => artifact.path === `vanilla/${node.definition.contract.name}.js`)!;
      await writeFile(join(app, `${node.definition.contract.name}.js`), module.content);
    }
    // Compiled modules create the app, or adopt the server's root in place.
    await writeFile(join(app, "vanilla-entry.ts"), `import { createXApp } from "./XApp.js";
const server = document.querySelector("#mount > [component]");
if (server) createXApp({}, undefined, server); else document.querySelector("#mount")!.append(createXApp());`);
    await build({ ...browserBuild, entryPoints: [join(app, "vanilla-entry.ts")], outfile: join(directory, "vanilla.js"), plugins: [emptyStyles],
      alias: { "@nextwebwg/html-next/generated-runtime": join(htmlNextSource, "generated-runtime.ts") } });
    bundles.set("vanilla", join(directory, "vanilla.js"));
    rendered = (await renderComponents("<x-app></x-app>", { definitions: [...graph.nodes.values()].map((node) => node.definition) })).html;

    for (const target of ["vue", "react", "svelte"] as const) {
      const out = join(app, target);
      const manifest = await convertComponents({ mode: "application", target, root: app, outDirectory: out, entries: ["app.html"] });
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

  const runs = [
    ...(["live", "vanilla"] as const).flatMap((target) => [[target, false], [target, true]] as const),
    ...(["vue", "react", "svelte"] as const).map((target) => [target, false] as const),
  ];
  for (const [engine, browserType] of [["Chromium", chromium], ["Firefox", firefox], ["WebKit", webkit]] as const) {
    for (const [target, server] of runs) {
      it(`${target}${server ? " hydrating Node output" : ""} creates the components of rows added later in ${engine}`, async () => {
        const browser = await browserType.launch({ headless: true });
        try {
          const page = await browser.newPage();
          const errors: string[] = [];
          page.on("pageerror", (error) => errors.push(error.message));
          page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
          const mount = `<div id="mount">${server ? rendered : target === "live" ? "<x-app></x-app>" : ""}</div>`;
          await page.route("https://app.example/**", (route) => new URL(route.request().url()).pathname === "/app.html"
            ? route.fulfill({ contentType: "text/html", body: source })
            : route.fulfill({ contentType: "text/html", body: target === "live" ? `<link rel="component" href="/app.html">${mount}` : mount }));
          await page.goto("https://app.example/");
          await page.addScriptTag({ path: bundles.get(target)! });
          if (target === "live") {
            await page.evaluate(() => (window as unknown as { HtmlNextLoader: { startBrowserComponents(): Promise<unknown> } }).HtmlNextLoader.startBrowserComponents())
              .catch((error: unknown) => errors.push(String(error)));
          }
          const first = { ".slotted > li": ["a"], ".slotted-if": [], ".plain > li": ["a"] };
          assert.deepEqual({ lists: await lists(page, first), errors }, { lists: first, errors: [] });
          await page.locator(".add").click();
          const added = { ".slotted > li": ["a", "b", "c"], ".slotted-if": ["more"], ".plain > li": ["a", "b", "c"] };
          assert.deepEqual({ lists: await lists(page, added), errors }, { lists: added, errors: [] });
        } finally { await browser.close(); }
      });
    }
  }
});
