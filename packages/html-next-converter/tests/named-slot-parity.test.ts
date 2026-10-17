import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, it } from "vitest";

import { compileScript, parse as parseVue } from "@vue/compiler-sfc";
import { build } from "esbuild";
import { chromium, firefox, webkit, type BrowserType, type Page } from "playwright";

import { generateComponent, parseComponentResource, type ComponentDefinition } from "@nextwebwg/html-next";
import { convertComponents } from "../src/index.js";
import { linkFormSource, namedSlotText, rowSource } from "./fixtures/named-slots.js";
import { sveltePlugin } from "./helpers/svelte.js";
import { launchParityBrowser } from "../../html-next/tests/pixel-parity.js";

/**
 * Named slot content, as Looma's link form passes it to its search result row: each slot's content
 * renders in that slot, the same in the live runtime, compiled output and each converted framework.
 */
const files: Readonly<Record<string, string>> = { "row.html": rowSource, "form.html": linkFormSource };
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

const slots = Object.keys(namedSlotText.initial);

async function slotText(page: Page, meta: string): Promise<Record<string, string>> {
  try {
    await page.waitForFunction((expected) => document.querySelector(".row .meta")?.textContent?.trim() === expected, meta, { timeout: 5_000 });
  } catch {
    throw new Error(`Expected meta ${meta}, got ${await page.evaluate(() => document.querySelector("#mount")?.innerHTML)}`);
  }
  return page.evaluate((names) => Object.fromEntries(names.map((name) =>
    [name, document.querySelector(`.row .${name}`)?.textContent?.replace(/\s+/g, " ").trim() ?? ""])), slots);
}

describe.skipIf(!enabled)("named slot content in the live runtime, compiled output and converted frameworks", () => {
  let directory = "";
  const bundles = new Map<string, string>();

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-named-slots-"));
    await symlink(nodeModules, join(directory, "node_modules"), "dir");
    for (const [name, contents] of Object.entries(files)) await writeFile(join(directory, name), contents);
    const live = join(directory, "live.js");
    await build({ entryPoints: [join(htmlNextSource, "browser-loader.ts")],
      outfile: live, bundle: true, format: "iife", globalName: "HtmlNextLoader", platform: "browser", target: ["es2022"] });
    bundles.set("live", live);

    const definitions: ComponentDefinition[] = [];
    for (const name of ["row.html", "form.html"]) definitions.push(...parseComponentResource(files[name]!, `file://${join(directory, name)}`).definitions);
    const invocations = new Map(definitions.map((definition) => [definition.contract.tag, { module: `./${definition.contract.name}.js`, definition }]));
    for (const definition of definitions) {
      const module = generateComponent(definition, { invocations }).find((artifact) => artifact.path === `vanilla/${definition.contract.name}.js`)!;
      await writeFile(join(directory, `${definition.contract.name}.js`), module.content);
    }
    await writeFile(join(directory, "vanilla-entry.js"), `import { createUiEditorLinkForm } from "./UiEditorLinkForm.js";\ndocument.querySelector("#mount").append(createUiEditorLinkForm());\n`);
    const vanilla = join(directory, "vanilla.js");
    await build({ entryPoints: [join(directory, "vanilla-entry.js")], outfile: vanilla, bundle: true, format: "iife", platform: "browser", target: ["es2022"],
      alias: { "@nextwebwg/html-next/generated-runtime": join(htmlNextSource, "generated-runtime.ts") }, plugins: [emptyStyles] });
    bundles.set("vanilla", vanilla);

    for (const target of ["vue", "react", "svelte"] as const) {
      const out = join(directory, target);
      const manifest = await convertComponents({ mode: "application", target, root: directory, outDirectory: out, entries: ["form.html"] });
      const form = manifest.components.find((component) => component.tag === "ui-editor-link-form")!.artifact;
      const entry = join(out, "entry.ts");
      const bundle = join(out, "bundle.js");
      if (target === "vue") {
        for (const component of manifest.components) {
          const path = join(out, component.artifact);
          const parsed = parseVue(await readFile(path, "utf8"), { filename: path });
          assert.deepEqual(parsed.errors, []);
          await writeFile(path.replace(/\.vue$/, ".ts"), compileScript(parsed.descriptor, { id: component.tag, inlineTemplate: true }).content);
        }
        await writeFile(entry, `import { createApp, h } from "vue"; import Form from "./${form}";
createApp({ render: () => h(Form) }).mount(document.querySelector("#mount")!);\n`);
        await build({ entryPoints: [entry], outfile: bundle, bundle: true, format: "iife", platform: "browser", target: ["es2022"],
          nodePaths: [nodeModules], plugins: [vuePlugin], loader: { ".css": "empty" } });
      } else if (target === "react") {
        await writeFile(join(out, "entry.tsx"), `import { createRoot } from "react-dom/client"; import Form from "./${form}";
createRoot(document.querySelector("#mount")!).render(<Form />);\n`);
        await build({ entryPoints: [join(out, "entry.tsx")], outfile: bundle, bundle: true, format: "iife", platform: "browser",
          target: ["es2022"], jsx: "automatic", nodePaths: [nodeModules], loader: { ".css": "empty" } });
      } else {
        await writeFile(entry, `import { mount } from "svelte"; import Form from "./${form}";
mount(Form, { target: document.querySelector("#mount")! });\n`);
        await build({ entryPoints: [entry], outfile: bundle, bundle: true, format: "iife", platform: "browser", target: ["es2022"],
          loader: { ".css": "empty" }, plugins: [sveltePlugin("client")] });
      }
      bundles.set(target, bundle);
    }
  }, 180_000);
  afterAll(async () => { if (directory !== "") await rm(directory, { recursive: true, force: true }); });

  for (const [engine, browserType] of [["Chromium", chromium], ["Firefox", firefox], ["WebKit", webkit]] as const satisfies ReadonlyArray<readonly [string, BrowserType]>) {
    for (const target of ["live", "vanilla", "vue", "react", "svelte"] as const) {
      it(`${engine} ${target} renders each named slot's content in its slot`, async () => {
        const browser = await launchParityBrowser(browserType);
        const errors: string[] = [];
        try {
          const page = await browser.newPage();
          page.on("pageerror", (error) => errors.push(error.message));
          page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
          await page.route("https://app.example/**", (route) => {
            const name = new URL(route.request().url()).pathname.slice(1);
            return route.fulfill({ contentType: "text/html", body: Object.hasOwn(files, name) ? files[name]! : target === "live"
              ? '<link rel="component" href="/form.html"><div id="mount"><ui-editor-link-form></ui-editor-link-form></div>'
              : '<div id="mount"></div>' });
          });
          await page.goto("https://app.example/");
          await page.addScriptTag({ path: bundles.get(target)! });
          if (target === "live") {
            await page.evaluate(() => (window as unknown as { HtmlNextLoader: { startBrowserComponents(): Promise<unknown> } }).HtmlNextLoader.startBrowserComponents());
          }
          assert.deepEqual(await slotText(page, namedSlotText.initial.meta), namedSlotText.initial);
          // Content that appears later goes to its slot, and the fallback comes back when it goes.
          await page.locator(".toggle").click();
          assert.deepEqual(await slotText(page, namedSlotText.toggled.meta), namedSlotText.toggled);
          await page.locator(".toggle").click();
          assert.deepEqual(await slotText(page, namedSlotText.closed.meta), namedSlotText.closed);
          assert.deepEqual(errors, []);
        } finally {
          await browser.close();
        }
      });
    }
  }
});
