import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, it } from "vitest";

import { compileScript, parse as parseVue } from "@vue/compiler-sfc";
import { build } from "esbuild";
import { chromium, type Page } from "playwright";

import { generateComponent, parseComponentResource } from "@nextwebwg/html-next";
import { convertComponents } from "../src/index.js";
import { sveltePlugin } from "./helpers/svelte.js";
import { launchParityBrowser } from "../../html-next/tests/pixel-parity.js";

/**
 * A controller's connection cleanup reads `host.root` and `host.element`, the root that is
 * disconnecting, in the live runtime, compiled output and each converted framework, including a
 * Vue component whose own render fails and replaces its root.
 */
const files: Readonly<Record<string, string>> = {
  "probe.html": `<template component="x-probe" status="early" summary="Records its root at cleanup." controller="./probe.js"><section class="probe"><slot></slot></section></template>`,
  "probe.js": `export default function controller(host) {
  host.on("connect", () => () => { window.seen.push([host.root?.localName ?? null, host.element?.localName ?? null]); });
}\n`,
};
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

/** Each target's way to remove the probe: `window.remove()`, and in Vue `window.fail()` too. */
const entries = {
  vanilla: `import { createXProbe } from "./XProbe.js";
const probe = createXProbe(); document.querySelector("#mount").append(probe);
window.remove = () => probe.remove();\n`,
  vue: (probe: string) => `import { createApp, h, ref } from "vue"; import Probe from "./${probe}";
const failing = ref(false);
const app = createApp({ render: () => h(Probe, null, { default: () => { if (failing.value) throw new Error("slot failed"); return "content"; } }) });
app.config.errorHandler = () => {};
app.mount(document.querySelector("#mount")!);
Object.assign(window, { remove: () => app.unmount(), fail: () => { failing.value = true; } });\n`,
  react: (probe: string) => `import { createRoot } from "react-dom/client"; import Probe from "./${probe}";
const root = createRoot(document.querySelector("#mount")!); root.render(<Probe />);
Object.assign(window, { remove: () => root.unmount() });\n`,
  svelte: (probe: string) => `import { mount, unmount } from "svelte"; import Probe from "./${probe}";
const app = mount(Probe, { target: document.querySelector("#mount")! });
Object.assign(window, { remove: () => unmount(app) });\n`,
};

async function cleanup(page: Page, action: "remove" | "fail"): Promise<unknown> {
  await page.waitForFunction(() => document.querySelector(".probe") !== null);
  // The controller module loads asynchronously; its connection starts once it has run.
  await page.waitForTimeout(100);
  await page.evaluate((name) => (window as unknown as Record<string, () => void>)[name]!(), action);
  await page.waitForFunction(() => (window as unknown as { seen: unknown[] }).seen.length > 0, undefined, { timeout: 5_000 });
  return page.evaluate(() => (window as unknown as { seen: unknown[] }).seen);
}

describe.skipIf(!enabled)("a controller's cleanup reads the root that disconnected", () => {
  let directory = "";
  const bundles = new Map<string, string>();

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-root-cleanup-"));
    await symlink(nodeModules, join(directory, "node_modules"), "dir");
    for (const [name, contents] of Object.entries(files)) await writeFile(join(directory, name), contents);
    const live = join(directory, "live.js");
    await build({ entryPoints: [join(htmlNextSource, "browser-loader.ts")],
      outfile: live, bundle: true, format: "iife", globalName: "HtmlNextLoader", platform: "browser", target: ["es2022"] });
    bundles.set("live", live);

    const [definition] = parseComponentResource(files["probe.html"]!, `file://${join(directory, "probe.html")}`).definitions;
    const module = generateComponent(definition!).find((artifact) => artifact.path === "vanilla/XProbe.js")!;
    await writeFile(join(directory, "XProbe.js"), module.content);
    await writeFile(join(directory, "vanilla-entry.js"), entries.vanilla);
    const vanilla = join(directory, "vanilla.js");
    await build({ entryPoints: [join(directory, "vanilla-entry.js")], outfile: vanilla, bundle: true, format: "iife", platform: "browser", target: ["es2022"],
      alias: { "@nextwebwg/html-next/generated-runtime": join(htmlNextSource, "generated-runtime.ts") }, plugins: [emptyStyles] });
    bundles.set("vanilla", vanilla);

    for (const target of ["vue", "react", "svelte"] as const) {
      const out = join(directory, target);
      const manifest = await convertComponents({ mode: "application", target, root: directory, outDirectory: out, entries: ["probe.html"] });
      const probe = manifest.components[0]!.artifact;
      const entry = join(out, target === "react" ? "entry.tsx" : "entry.ts");
      const bundle = join(out, "bundle.js");
      if (target === "vue") {
        const path = join(out, probe);
        const parsed = parseVue(await readFile(path, "utf8"), { filename: path });
        assert.deepEqual(parsed.errors, []);
        await writeFile(path.replace(/\.vue$/, ".ts"), compileScript(parsed.descriptor, { id: "x-probe", inlineTemplate: true }).content);
      }
      await writeFile(entry, entries[target](probe));
      await build({ entryPoints: [entry], outfile: bundle, bundle: true, format: "iife", platform: "browser", target: ["es2022"],
        jsx: "automatic", nodePaths: [nodeModules], loader: { ".css": "empty" },
        plugins: target === "vue" ? [vuePlugin] : target === "svelte" ? [sveltePlugin("client")] : [] });
      bundles.set(target, bundle);
    }
  }, 180_000);
  afterAll(async () => { if (directory !== "") await rm(directory, { recursive: true, force: true }); });

  // ponytail: Chromium only; the ordering under test is each framework's, not the engine's.
  const cases = [...["live", "vanilla", "vue", "react", "svelte"].map((target) => [target, "remove"] as const), ["vue", "fail"] as const];
  for (const [target, action] of cases) {
    it(`${target} cleanup reads the root after ${action === "remove" ? "removal" : "a failed render of its slot"}`, async () => {
      const browser = await launchParityBrowser(chromium);
      const errors: string[] = [];
      try {
        const page = await browser.newPage();
        page.on("pageerror", (error) => errors.push(error.message));
        await page.route("https://app.example/**", (route) => {
          const name = new URL(route.request().url()).pathname.slice(1);
          return route.fulfill({ contentType: name.endsWith(".js") ? "text/javascript" : "text/html", body: Object.hasOwn(files, name) ? files[name]! : target === "live"
            ? '<link rel="component" href="/probe.html"><div id="mount"><x-probe></x-probe></div>'
            : '<div id="mount"></div>' });
        });
        await page.goto("https://app.example/");
        await page.evaluate(() => { (window as unknown as { seen: unknown[] }).seen = []; });
        await page.addScriptTag({ path: bundles.get(target)! });
        if (target === "live") {
          await page.evaluate(() => {
            const loader = (window as unknown as { HtmlNextLoader: { startBrowserComponents(): Promise<unknown> } }).HtmlNextLoader;
            Object.assign(window, { remove: () => document.querySelector(".probe")!.remove() });
            return loader.startBrowserComponents();
          });
        }
        assert.deepEqual(await cleanup(page, action), [["section", "section"]]);
        assert.deepEqual(errors, []);
      } finally {
        await browser.close();
      }
    });
  }
});
