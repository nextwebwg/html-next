import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, it } from "vitest";

import { compileScript, parse as parseVue } from "@vue/compiler-sfc";
import { build, type BuildOptions } from "esbuild";
import { chromium } from "playwright";

import { generateComponent, parseComponent } from "@nextwebwg/html-next";
import { convertComponents } from "../src/index.js";
import { sveltePlugin } from "./helpers/svelte.js";

/**
 * Null means not present (https://nextwebwg.org/declarative-components/types#null-and-missing-values):
 * a null prop, from `componentRegistry.update` or a framework, falls back to its default, and a controller's null write is never wrong-typed, while a
 * wrong-typed value still warns. Run in the live runtime, compiled Vanilla output and converted Vue,
 * React and Svelte components.
 */
const enabled = process.env.HTMLNEXT_TARGET_TEST === "1";
const nodeModules = fileURLToPath(new URL("../node_modules", import.meta.url));
const htmlNextSource = fileURLToPath(new URL("../../html-next/src/", import.meta.url));

const source = `<template component="x-nullable" status="early" summary="Null writes." controller="./nullable.js"><defs>
  <prop name="tone" type="keyword" values="plain, loud" default="plain">The tone.</prop>
  <state type="keyword" name="headingRole"></state>
  <state type="integer" name="headingLevel"></state>
  <state type="integer" name="count" value="1"></state>
</defs><div class="heading" from:data-tone="$tone" from:role="$headingRole" from:aria-level="$headingLevel" from:data-count="$count"></div></template>`;
const controller = `export default function initialize(host) {
  host.on("connect", () => { host.state.headingRole = "heading"; host.state.headingLevel = 2; });
  host.on("clear", () => { host.state.headingRole = null; host.state.headingLevel = undefined; });
  host.on("wrong", () => { host.state.count = "many"; });
}`;
const vuePlugin = { name: "compiled-vue-sfc", setup(pluginBuild: { onResolve: (options: { filter: RegExp }, callback: (args: { path: string; resolveDir: string }) => { path: string }) => void }) {
  pluginBuild.onResolve({ filter: /\.vue$/ }, (args) => ({ path: resolve(args.resolveDir, args.path.replace(/\.vue$/, ".ts")) }));
} };
const emptyStyles = { name: "empty-styles", setup(pluginBuild: { onResolve: (options: { filter: RegExp }, callback: (args: { path: string }) => { path: string; namespace: string }) => void; onLoad: (options: { filter: RegExp; namespace: string }, callback: () => { contents: string; loader: "js" }) => void }) {
  pluginBuild.onResolve({ filter: /\.css$/ }, (args) => ({ path: args.path, namespace: "empty-style" }));
  pluginBuild.onLoad({ filter: /.*/, namespace: "empty-style" }, () => ({ contents: "", loader: "js" }));
} };

type Target = "live" | "vanilla" | "vue" | "react" | "svelte";

describe.skipIf(!enabled)("null writes in every target", () => {
  let directory = "";
  const bundles = new Map<Target, string>();

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-null-writes-"));
    await symlink(nodeModules, join(directory, "node_modules"), "dir");
    const app = join(directory, "app");
    await mkdir(app);
    await writeFile(join(app, "nullable.html"), source);
    await writeFile(join(app, "nullable.js"), controller);
    const browserBuild: BuildOptions = { bundle: true, format: "iife", platform: "browser", target: ["es2022"], jsx: "automatic", nodePaths: [nodeModules], loader: { ".css": "empty" } };

    // Each page exposes `setTone`, which sets the tone prop the way its target's owner does.
    await writeFile(join(app, "live-entry.ts"), `import { startBrowserComponents } from ${JSON.stringify(join(htmlNextSource, "browser-loader.ts"))};
import { componentRegistry } from ${JSON.stringify(join(htmlNextSource, "runtime.ts"))};
document.querySelector("#mount")!.innerHTML = '<link rel="component" href="/nullable.html"><x-nullable></x-nullable>';
startBrowserComponents();
(globalThis as any).setTone = (tone: unknown) => componentRegistry.update(document.querySelector(".heading")!, { tone });`);
    await build({ ...browserBuild, entryPoints: [join(app, "live-entry.ts")], outfile: join(directory, "live.js") });
    bundles.set("live", join(directory, "live.js"));

    const vanilla = generateComponent(parseComponent(source, "https://app.example/nullable.html"))
      .find((artifact) => artifact.path === "vanilla/XNullable.js")!;
    await writeFile(join(app, "XNullable.js"), vanilla.content);
    await writeFile(join(app, "vanilla-entry.ts"), `import { createXNullable } from "./XNullable.js";
import { componentRegistry } from "@nextwebwg/html-next/generated-runtime";
const element = createXNullable();
document.querySelector("#mount")!.append(element);
(globalThis as any).setTone = (tone: unknown) => componentRegistry.update(element, { tone });`);
    await build({ ...browserBuild, entryPoints: [join(app, "vanilla-entry.ts")], outfile: join(directory, "vanilla.js"), plugins: [emptyStyles],
      define: { "import.meta.url": JSON.stringify("https://app.example/XNullable.js") },
      alias: { "@nextwebwg/html-next/generated-runtime": join(htmlNextSource, "generated-runtime.ts") } });
    bundles.set("vanilla", join(directory, "vanilla.js"));

    for (const target of ["vue", "react", "svelte"] as const) {
      const out = join(app, target);
      const manifest = await convertComponents({ mode: "application", target, root: app, outDirectory: out, entries: ["nullable.html"] });
      const artifact = manifest.components[0]!.artifact;
      if (target === "vue") {
        const path = join(out, artifact);
        const parsed = parseVue(await readFile(path, "utf8"), { filename: path });
        assert.deepEqual(parsed.errors, []);
        await writeFile(path.replace(/\.vue$/, ".ts"), compileScript(parsed.descriptor, { id: "x-nullable", inlineTemplate: true }).content);
      }
      const entry = {
        vue: `import { createApp, h, reactive } from "vue";
import XNullable from "./${artifact}";
const props = reactive<{ tone?: unknown }>({});
createApp({ render: () => h(XNullable as any, { tone: props.tone }) }).mount("#mount");
(globalThis as any).setTone = (tone: unknown) => { props.tone = tone; };`,
        react: `import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import XNullable from "./${artifact}";
const root = createRoot(document.querySelector("#mount")!);
const render = (tone?: unknown) => flushSync(() => root.render(<XNullable {...{ tone } as any} />));
render();
(globalThis as any).setTone = render;`,
        svelte: `import { mount } from "svelte";
import XNullable from "./${artifact}";
const props = $state<{ tone?: unknown }>({});
mount(XNullable, { target: document.querySelector("#mount")!, props: props as any });
(globalThis as any).setTone = (tone: unknown) => { props.tone = tone; };`,
      }[target];
      const entryPath = join(out, target === "react" ? "entry.tsx" : target === "svelte" ? "entry.svelte.ts" : "entry.ts");
      await writeFile(entryPath, entry);
      await build({ ...browserBuild, entryPoints: [entryPath], outfile: join(directory, `${target}.js`),
        plugins: target === "vue" ? [vuePlugin] : target === "svelte" ? [sveltePlugin("client")] : [] });
      bundles.set(target, join(directory, `${target}.js`));
    }
  }, 120_000);
  afterAll(async () => { if (directory !== "") await rm(directory, { recursive: true, force: true }); });

  for (const target of ["live", "vanilla", "vue", "react", "svelte"] as const) {
    it(`${target} returns a null prop to its default, writes null state without a warning, and warns for a wrong type`, async () => {
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
          if (url.pathname === "/nullable.html") return route.fulfill({ contentType: "text/html", body: source });
          if (url.pathname === "/nullable.js") return route.fulfill({ contentType: "text/javascript", body: controller });
          return route.fulfill({ contentType: "text/html", body: '<!doctype html><body><div id="mount"></div></body>' });
        });
        await page.goto("https://app.example/");
        await page.addScriptTag({ path: bundles.get(target)! });
        await page.waitForSelector('.heading[role="heading"][aria-level="2"]', { state: "attached", timeout: 10_000 });
        const read = () => page.evaluate(() => {
          const heading = document.querySelector(".heading")!;
          return { tone: heading.getAttribute("data-tone"), role: heading.getAttribute("role"), level: heading.getAttribute("aria-level"), count: heading.getAttribute("data-count") };
        });
        const settle = () => page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
        assert.deepEqual(await read(), { tone: "plain", role: "heading", level: "2", count: "1" });

        // A null prop is not present, so the default applies again.
        await page.evaluate(() => (globalThis as unknown as { setTone(tone: unknown): void }).setTone("loud"));
        await page.waitForSelector('.heading[data-tone="loud"]', { state: "attached", timeout: 5_000 });
        await page.evaluate(() => (globalThis as unknown as { setTone(tone: unknown): void }).setTone(null));
        await page.waitForSelector('.heading[data-tone="plain"]', { state: "attached", timeout: 5_000 });

        // Null and undefined writes to a state without value make it not present: no HR007.
        await page.evaluate(() => document.querySelector(".heading")!.dispatchEvent(new Event("clear")));
        await page.waitForFunction(() => !document.querySelector(".heading")!.hasAttribute("role"), undefined, { timeout: 5_000 });
        await settle();
        assert.deepEqual(await read(), { tone: "plain", role: null, level: null, count: "1" });
        assert.deepEqual(warnings.filter((warning) => warning.includes("HR007")), []);

        // A present value of the wrong type still warns once and writes nothing.
        await page.evaluate(() => document.querySelector(".heading")!.dispatchEvent(new Event("wrong")));
        await settle();
        assert.deepEqual(await read(), { tone: "plain", role: null, level: null, count: "1" });
        const refused = warnings.filter((warning) => warning.includes("HR007"));
        assert.equal(refused.length, 1, refused.join("\n"));
        assert.match(refused[0]!, /count/);
        assert.deepEqual(errors, []);
      } finally { await browser.close(); }
    });
  }
});
