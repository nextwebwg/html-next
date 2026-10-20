import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, it } from "vitest";

import { compileScript, parse as parseVue } from "@vue/compiler-sfc";
import { build, type BuildOptions } from "esbuild";
import { chromium, type Page } from "playwright";

import { generateComponent, loadNodeComponents } from "@nextwebwg/html-next";
import { convertComponents } from "../src/index.js";
import { sveltePlugin } from "./helpers/svelte.js";

/**
 * A component forwards its own slot to a child's slot of the same name through a `<template slot>`
 * (https://nextwebwg.org/declarative-components/components#content-that-renders-on-demand): a named
 * slot under the child's `$if`, two levels deep, the default slot, and a scoped slot passing its
 * props on. The forwarded content renders once, in the inner slot, in the consumer's scope. Run in
 * the live runtime, compiled Vanilla output and converted Vue, React and Svelte components.
 */
const enabled = process.env.HTMLNEXT_TARGET_TEST === "1";
const nodeModules = fileURLToPath(new URL("../node_modules", import.meta.url));
const htmlNextSource = fileURLToPath(new URL("../../html-next/src/", import.meta.url));

const component = (tag: string, body: string): string => `<template component="${tag}" status="early" summary="${tag}.">${body}</template>`;
const open = `<defs><prop name="open" type="boolean" default="true">Open.</prop></defs>`;
const row = `<slot name="row"><prop name="item" type="string" required>The item.</prop></slot>`;
const source = [
  component("x-panel", `${open}<div class="panel"><section $if="$open"><slot name="details"></slot></section></div>`),
  component("x-relay", `${open}<x-panel from:open="$open"><template slot="details"><slot name="details"></slot></template></x-panel>`),
  component("x-relay-deep", `${open}<x-relay from:open="$open"><template slot="details"><slot name="details"></slot></template></x-relay>`),
  component("x-box", `<div class="box"><slot></slot></div>`),
  component("x-box-relay", `<x-box><template slot=""><slot></slot></template></x-box>`),
  component("x-list", `<defs><prop name="items" type="list(string)" default="['a', 'b']">The items.</prop>${row}</defs><ul><li $each="i of $items"><slot name="row" from:item="$i"></slot></li></ul>`),
  component("x-list-relay", `<defs>${row}</defs><x-list><template slot="row"><slot name="row" from:item="$item"></slot></template></x-list>`),
  component("x-app", `<defs><state name="open" type="boolean" value="true"></state><handler name="toggle"><set name="open" expr:value="not $open"></set></handler></defs>
<main><button type="button" class="toggle" on:click="toggle">Toggle</button>
<x-relay from:open="$open"><p slot="details" class="named">Named</p></x-relay>
<x-relay-deep from:open="$open"><template slot="details"><p class="deep">{$open ? 'Deep' : 'Closed'}</p></template></x-relay-deep>
<x-box-relay><p class="default">Default</p></x-box-relay>
<x-list-relay><template slot="row"><b class="row">{$item}</b></template></x-list-relay></main>`),
].join("\n");

const vuePlugin = { name: "compiled-vue-sfc", setup(pluginBuild: { onResolve: (options: { filter: RegExp }, callback: (args: { path: string; resolveDir: string }) => { path: string }) => void }) {
  pluginBuild.onResolve({ filter: /\.vue$/ }, (args) => ({ path: resolve(args.resolveDir, args.path.replace(/\.vue$/, ".ts")) }));
} };
const emptyStyles = { name: "empty-styles", setup(pluginBuild: { onResolve: (options: { filter: RegExp }, callback: (args: { path: string }) => { path: string; namespace: string }) => void; onLoad: (options: { filter: RegExp; namespace: string }, callback: () => { contents: string; loader: "js" }) => void }) {
  pluginBuild.onResolve({ filter: /\.css$/ }, (args) => ({ path: args.path, namespace: "empty-style" }));
  pluginBuild.onLoad({ filter: /.*/, namespace: "empty-style" }, () => ({ contents: "", loader: "js" }));
} };

type Target = "live" | "vanilla" | "vue" | "react" | "svelte";
type Rendered = Record<string, string[]>;

/** Each forwarded element's text, counting only elements that render visibly, so duplicates and inert copies show. */
const READ = `Object.fromEntries(["named", "deep", "default", "row"].map((name) => [name,
  Array.from(document.querySelectorAll("." + name)).filter((element) => element.getClientRects().length > 0).map((element) => element.textContent.trim())]))`;

async function rendered(page: Page, expected: Rendered): Promise<Rendered> {
  await page.waitForFunction(`JSON.stringify(${READ}) === ${JSON.stringify(JSON.stringify(expected))}`, undefined, { timeout: 5_000 }).catch(() => {});
  return page.evaluate(READ) as Promise<Rendered>;
}

describe.skipIf(!enabled)("a slot forwarded to a child's slot of the same name", () => {
  let directory = "";
  const bundles = new Map<Target, string>();

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-slot-forwarding-"));
    await symlink(nodeModules, join(directory, "node_modules"), "dir");
    const app = join(directory, "app");
    await mkdir(app);
    await writeFile(join(app, "forward.html"), source);
    const browserBuild: BuildOptions = { bundle: true, format: "iife", platform: "browser", target: ["es2022"], jsx: "automatic", nodePaths: [nodeModules], loader: { ".css": "empty" } };

    await build({ ...browserBuild, entryPoints: [join(htmlNextSource, "browser-loader.ts")], outfile: join(directory, "live.js"), globalName: "HtmlNextLoader" });
    bundles.set("live", join(directory, "live.js"));

    // Compiled Vanilla modules beside their source, so a component's import of another resolves.
    const graph = await loadNodeComponents([pathToFileURL(join(app, "forward.html")).href]);
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
      const manifest = await convertComponents({ mode: "application", target, root: app, outDirectory: out, entries: ["forward.html"] });
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

  for (const target of ["live", "vanilla", "vue", "react", "svelte"] as const) {
    it(`${target} renders forwarded content once, in the inner slot, while that slot renders`, async () => {
      const browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage();
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
        await page.route("https://app.example/**", (route) => new URL(route.request().url()).pathname === "/forward.html"
          ? route.fulfill({ contentType: "text/html", body: source })
          : route.fulfill({ contentType: "text/html", body: target === "live"
            ? '<link rel="component" href="/forward.html"><div id="mount"><x-app></x-app></div>' : '<div id="mount"></div>' }));
        await page.goto("https://app.example/");
        await page.addScriptTag({ path: bundles.get(target)! });
        if (target === "live") {
          await page.evaluate(() => (window as unknown as { HtmlNextLoader: { startBrowserComponents(): Promise<unknown> } }).HtmlNextLoader.startBrowserComponents())
            .catch((error: unknown) => errors.push(String(error)));
        }
        const shown = { named: ["Named"], deep: ["Deep"], default: ["Default"], row: ["a", "b"] };
        assert.deepEqual({ rendered: await rendered(page, shown), errors }, { rendered: shown, errors: [] });
        // Closing the inner `$if` removes the forwarded content; reopening renders it again.
        await page.locator(".toggle").click();
        const closed = { named: [], deep: [], default: ["Default"], row: ["a", "b"] };
        assert.deepEqual({ rendered: await rendered(page, closed), errors }, { rendered: closed, errors: [] });
        await page.locator(".toggle").click();
        assert.deepEqual({ rendered: await rendered(page, shown), errors }, { rendered: shown, errors: [] });
      } finally { await browser.close(); }
    });
  }
});
