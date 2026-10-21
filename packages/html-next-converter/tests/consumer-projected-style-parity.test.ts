import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, it } from "vitest";

import { compileScript, compileStyle, parse as parseVue } from "@vue/compiler-sfc";
import { build } from "esbuild";
import { chromium, firefox, webkit, type BrowserType, type Page } from "playwright";

import { generateComponent, parseComponentResource, type ComponentDefinition } from "@nextwebwg/html-next";
import { convertComponents } from "../src/index.js";
import { sveltePlugin, svelteStyles } from "./helpers/svelte.js";
import { launchParityBrowser } from "../../html-next/tests/pixel-parity.js";

/**
 * A consumer's styles reach the markup it projects into a child component's slot, at any depth,
 * because that markup is the consumer's own (https://nextwebwg.org/declarative-components/styling#projected-content-is-the-consumers),
 * as light-DOM children are styled by their own tree. The receiving component's ordinary rules still
 * do not reach it, its `:slotted()` rules do and stop at a projected component's root, and a
 * projected component keeps its own scope against the consumer's rules. The frame projects its own
 * markup into a badge in turn: the frame's rules reach that markup and the page's do not. The page
 * and the frame both have slots, which Vue and Svelte scope differently. The same in every target.
 */
const frame = `<link rel="component" href="./badge.html">
<template component="x-frame" status="early" summary="Frame."><header class="frame"><span class="frame-own">F</span><slot name="menu"></slot><slot></slot><x-badge><span class="menu frame-menu">FM</span></x-badge></header>
  <style>header { border: 1px solid; } span { text-decoration-line: underline; } :slotted(*) { font-style: italic; }</style></template>`;
const badge = `<template component="x-badge" status="early" summary="Badge."><b class="badge"><slot></slot></b>
  <style>:host { color: rgb(0, 128, 0); }</style></template>`;
const page = `<link rel="component" href="./frame.html"><link rel="component" href="./badge.html">
<template component="x-page" status="early" summary="Page."><main><slot name="extra"></slot><x-frame><span class="menu" slot="menu">Menu <i class="deep">deep</i></span><x-badge>B</x-badge></x-frame><span class="own">Own</span></main>
  <style>.menu, .own, .deep { color: rgb(255, 0, 0); } :host .deep { text-transform: uppercase; } .menu .deep { letter-spacing: 2px; } .frame .deep { word-spacing: 3px; } b { color: rgb(255, 0, 255); font-style: oblique; }</style></template>`;
const files: Readonly<Record<string, string>> = { "frame.html": frame, "badge.html": badge, "page.html": page };
const enabled = process.env.HTMLNEXT_TARGET_TEST === "1";
const nodeModules = fileURLToPath(new URL("../node_modules", import.meta.url));
const htmlNextSource = fileURLToPath(new URL("../../html-next/src/", import.meta.url));
const vuePlugin = { name: "compiled-vue-sfc", setup(pluginBuild: { onResolve: (options: { filter: RegExp }, callback: (args: { path: string; resolveDir: string }) => { path: string }) => void }) {
  pluginBuild.onResolve({ filter: /\.vue$/ }, (args) => ({ path: resolve(args.resolveDir, args.path.replace(/\.vue$/, ".ts")) }));
} };
const emptyStyles = { name: "empty-styles", setup(pluginBuild: { onResolve: (options: { filter: RegExp }, callback: (args: { path: string }) => { path: string; namespace: string }) => void; onLoad: (options: { filter: RegExp; namespace: string }, callback: () => { contents: string; loader: "js" }) => void }) {
  pluginBuild.onResolve({ filter: /\.css$/ }, (args) => ({ path: args.path, namespace: "empty-style" }));
  pluginBuild.onLoad({ filter: /.*/, namespace: "empty-style" }, () => ({ contents: "", loader: "js" }));
} };

/** What each stylesheet reached: the consumer's projected and own markup, the frame's own markup, and the projected badge. */
async function styled(page: Page): Promise<Record<string, string>> {
  await page.waitForSelector(".menu .deep");
  return page.evaluate(() => {
    const style = (selector: string) => getComputedStyle(document.querySelector(selector)!);
    return { menuColor: style(".menu").color, menuDecoration: style(".menu").textDecorationLine, menuFont: style(".menu").fontStyle,
      deepColor: style(".deep").color, deepTransform: style(".deep").textTransform,
      deepContext: style(".deep").letterSpacing, deepForeignContext: style(".deep").wordSpacing, ownColor: style(".own").color,
      frameOwn: style(".frame-own").textDecorationLine, badgeColor: style(".badge").color, badgeFont: style(".badge").fontStyle,
      frameMenuColor: style(".frame-menu").color, frameMenuDecoration: style(".frame-menu").textDecorationLine, frameMenuFont: style(".frame-menu").fontStyle };
  });
}

describe.skipIf(!enabled)("a consumer's styles reach the markup it projects in every target", () => {
  let directory = "";
  const bundles = new Map<string, string>();
  const styles = new Map<string, string>();

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-consumer-styles-"));
    await symlink(nodeModules, join(directory, "node_modules"), "dir");
    for (const [name, contents] of Object.entries(files)) await writeFile(join(directory, name), contents);
    const live = join(directory, "live.js");
    await build({ entryPoints: [join(htmlNextSource, "browser-loader.ts")],
      outfile: live, bundle: true, format: "iife", globalName: "HtmlNextLoader", platform: "browser", target: ["es2022"] });
    bundles.set("live", live);

    const definitions: ComponentDefinition[] = [];
    for (const name of ["frame.html", "badge.html", "page.html"]) definitions.push(...parseComponentResource(files[name]!, `file://${join(directory, name)}`).definitions);
    const invocations = new Map(definitions.map((definition) => [definition.contract.tag, { module: `./${definition.contract.name}.js`, definition }]));
    for (const definition of definitions) {
      const artifacts = generateComponent(definition, { invocations });
      const module = artifacts.find((artifact) => artifact.path === `vanilla/${definition.contract.name}.js`)!;
      styles.set("vanilla", `${styles.get("vanilla") ?? ""}${artifacts.filter((artifact) => artifact.path.startsWith("styles/")).map((artifact) => artifact.content).join("\n")}\n`);
      await writeFile(join(directory, `${definition.contract.name}.js`), module.content);
    }
    await writeFile(join(directory, "vanilla-entry.js"), `import { createXPage } from "./XPage.js";\ndocument.querySelector("#mount").append(createXPage());\n`);
    const vanilla = join(directory, "vanilla.js");
    await build({ entryPoints: [join(directory, "vanilla-entry.js")], outfile: vanilla, bundle: true, format: "iife", platform: "browser", target: ["es2022"],
      alias: { "@nextwebwg/html-next/generated-runtime": join(htmlNextSource, "generated-runtime.ts") }, plugins: [emptyStyles] });
    bundles.set("vanilla", vanilla);

    for (const target of ["vue", "react", "svelte"] as const) {
      const out = join(directory, target);
      const manifest = await convertComponents({ mode: "application", target, root: directory, outDirectory: out, entries: ["page.html"] });
      const form = manifest.components.find((component) => component.tag === "x-page")!.artifact;
      const entry = join(out, "entry.ts");
      const bundle = join(out, "bundle.js");
      if (target === "vue") {
        for (const component of manifest.components) {
          const path = join(out, component.artifact);
          const parsed = parseVue(await readFile(path, "utf8"), { filename: path });
          assert.deepEqual(parsed.errors, []);
          await writeFile(path.replace(/\.vue$/, ".ts"), compileScript(parsed.descriptor, { id: component.tag, inlineTemplate: true }).content);
          styles.set("vue", `${styles.get("vue") ?? ""}${parsed.descriptor.styles.map((style) =>
            compileStyle({ source: style.content, filename: path, id: `data-v-${component.tag}`, scoped: style.scoped === true }).code).join("\n")}\n`);
        }
        await writeFile(entry, `import { createApp, h } from "vue"; import Form from "./${form}";
createApp({ render: () => h(Form) }).mount(document.querySelector("#mount")!);\n`);
        await build({ entryPoints: [entry], outfile: bundle, bundle: true, format: "iife", platform: "browser", target: ["es2022"],
          nodePaths: [nodeModules], plugins: [vuePlugin], loader: { ".css": "empty" } });
      } else if (target === "react") {
        styles.set("react", (await Promise.all(manifest.output.artifacts.filter((artifact) => artifact.kind === "style")
          .map((artifact) => readFile(join(out, artifact.path), "utf8")))).join("\n"));
        await writeFile(join(out, "entry.tsx"), `import { createRoot } from "react-dom/client"; import Form from "./${form}";
createRoot(document.querySelector("#mount")!).render(<Form />);\n`);
        await build({ entryPoints: [join(out, "entry.tsx")], outfile: bundle, bundle: true, format: "iife", platform: "browser",
          target: ["es2022"], jsx: "automatic", nodePaths: [nodeModules], loader: { ".css": "empty" } });
      } else {
        await writeFile(entry, `import { mount } from "svelte"; import Form from "./${form}";
mount(Form, { target: document.querySelector("#mount")! });\n`);
        await build({ entryPoints: [entry], outfile: bundle, bundle: true, format: "iife", platform: "browser", target: ["es2022"],
          loader: { ".css": "empty" }, plugins: [sveltePlugin("client")] });
        styles.set("svelte", svelteStyles(out));
      }
      bundles.set(target, bundle);
    }
  }, 180_000);
  afterAll(async () => { if (directory !== "") await rm(directory, { recursive: true, force: true }); });

  for (const [engine, browserType] of [["Chromium", chromium], ["Firefox", firefox], ["WebKit", webkit]] as const satisfies ReadonlyArray<readonly [string, BrowserType]>) {
    for (const target of ["live", "vanilla", "vue", "react", "svelte"] as const) {
      it(`${engine} ${target} styles the markup a consumer projects with the consumer's rules`, async () => {
        const browser = await launchParityBrowser(browserType);
        const errors: string[] = [];
        try {
          const page = await browser.newPage();
          page.on("pageerror", (error) => errors.push(error.message));
          page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
          await page.route("https://app.example/**", (route) => {
            const name = new URL(route.request().url()).pathname.slice(1);
            return route.fulfill({ contentType: "text/html", body: Object.hasOwn(files, name) ? files[name]! : target === "live"
              ? '<link rel="component" href="/page.html"><div id="mount"><x-page></x-page></div>'
              : '<div id="mount"></div>' });
          });
          await page.goto("https://app.example/");
          await page.addScriptTag({ path: bundles.get(target)! });
          if (target === "live") {
            await page.evaluate(() => (window as unknown as { HtmlNextLoader: { startBrowserComponents(): Promise<unknown> } }).HtmlNextLoader.startBrowserComponents());
          }
          if (styles.has(target)) await page.addStyleTag({ content: styles.get(target)! });
          assert.deepEqual(await styled(page), {
            menuColor: "rgb(255, 0, 0)", menuDecoration: "none", menuFont: "italic",
            deepColor: "rgb(255, 0, 0)", deepTransform: "uppercase", ownColor: "rgb(255, 0, 0)",
            // Context stays in the page's markup: the frame's `.frame` header is not the page's.
            deepContext: "2px", deepForeignContext: "0px",
            frameOwn: "underline", badgeColor: "rgb(0, 128, 0)", badgeFont: "normal",
            frameMenuColor: "rgb(0, 128, 0)", frameMenuDecoration: "underline", frameMenuFont: "normal",
          });
          assert.deepEqual(errors, []);
        } finally {
          await browser.close();
        }
      });
    }
  }
});
