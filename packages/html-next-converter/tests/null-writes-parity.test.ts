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
 * a null prop, from `componentRegistry.update` or a framework, falls back to its default; a null
 * state write reverts a state with a `value` to it, at the root and below, and a state without one
 * holds null; `host.reset` restores declared values; and an emptied bound control keeps showing empty
 * while its state reverts. A wrong-typed value still warns. Run in the live runtime, compiled Vanilla
 * output and converted Vue, React and Svelte components.
 */
const enabled = process.env.HTMLNEXT_TARGET_TEST === "1";
const nodeModules = fileURLToPath(new URL("../node_modules", import.meta.url));
const htmlNextSource = fileURLToPath(new URL("../../html-next/src/", import.meta.url));

const source = `<template component="x-nullable" status="early" summary="Null writes." controller="./nullable.js"><defs>
  <prop name="tone" type="keyword" values="plain, loud" default="plain">The tone.</prop>
  <state type="keyword" name="headingRole"></state>
  <state type="integer" name="headingLevel"></state>
  <state type="integer" name="count" value="1"></state>
  <state type="object({ name: string })" name="draft" value="{ name: 'Ada' }"></state>
  <state type="integer" name="amount" value="0"></state>
  <handler name="clearCount"><set name="count" expr:value="null"></set></handler>
</defs><div class="heading" from:data-tone="$tone" from:role="$headingRole" from:aria-level="$headingLevel" from:data-count="$count" from:data-name="$draft.name" from:data-amount="$amount"><input class="amount" type="number" bind:value="amount"><button class="clear" type="button" on:click="clearCount">Clear</button></div></template>`;
const controller = `export default function initialize(host) {
  globalThis.componentHost = host;
  host.on("connect", () => { host.state.headingRole = "heading"; host.state.headingLevel = 2; });
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
    it(`${target} clears a null prop to its default, reverts a state with a value, resets through host.reset, and keeps an emptied control empty`, async () => {
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
          return { tone: heading.getAttribute("data-tone"), role: heading.getAttribute("role"), level: heading.getAttribute("aria-level"),
            count: heading.getAttribute("data-count"), name: heading.getAttribute("data-name"), amount: heading.getAttribute("data-amount") };
        });
        const settle = () => page.evaluate(() => new Promise<void>((done) => setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(() => done())), 0)));
        const act = async (script: string): Promise<void> => { await page.evaluate(script); await settle(); };
        const host = "globalThis.componentHost";
        await settle();
        assert.deepEqual(await read(), { tone: "plain", role: "heading", level: "2", count: "1", name: "Ada", amount: "0" });

        // A null prop is not present, so the default applies again.
        await act("setTone('loud')");
        assert.equal((await read()).tone, "loud");
        await act("setTone(null)");
        assert.equal((await read()).tone, "plain");

        // A state without value stores null and undefined; a state with one goes back to it, at the root and below.
        await act(`${host}.state.headingRole = null; ${host}.state.headingLevel = undefined; ${host}.state.count = 5; ${host}.state.draft.name = 'Bea';`);
        assert.deepEqual(await read(), { tone: "plain", role: null, level: null, count: "5", name: "Bea", amount: "0" });
        await act(`${host}.state.count = null; ${host}.state.draft.name = null;`);
        assert.deepEqual(await read(), { tone: "plain", role: null, level: null, count: "1", name: "Ada", amount: "0" });
        // A <set> of null reverts too.
        await act(`${host}.state.count = 7;`);
        await act("document.querySelector('button.clear').click()");
        assert.equal((await read()).count, "1");

        // host.reset returns one state, or every state, to its declared value; another name throws.
        await act(`${host}.state.count = 9; ${host}.state.headingRole = 'heading'; ${host}.state.draft = { name: 'Cy' };`);
        await act(`${host}.reset('count');`);
        assert.deepEqual(await read(), { tone: "plain", role: "heading", level: null, count: "1", name: "Cy", amount: "0" });
        await act(`${host}.reset();`);
        assert.deepEqual(await read(), { tone: "plain", role: null, level: null, count: "1", name: "Ada", amount: "0" });
        assert.deepEqual(await page.evaluate(`[${["tone", "missing"].map((name) => `(() => { try { ${host}.reset('${name}'); return 'none'; } catch (error) { return error.name; } })()`).join(", ")}]`), ["TypeError", "TypeError"]);

        // An emptied control reverts its state, and the control is not echoed the declared value.
        await act("{ const input = document.querySelector('input.amount'); input.value = '5'; input.dispatchEvent(new Event('input', { bubbles: true })); }");
        assert.equal((await read()).amount, "5");
        await act("{ const input = document.querySelector('input.amount'); input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true })); }");
        assert.deepEqual([(await read()).amount, await page.evaluate("document.querySelector('input.amount').value")], ["0", ""]);
        // A later write from elsewhere shows in the control.
        await act(`${host}.state.amount = 3;`);
        assert.deepEqual([(await read()).amount, await page.evaluate("document.querySelector('input.amount').value")], ["3", "3"]);
        assert.deepEqual(warnings.filter((warning) => warning.includes("HR007")), []);

        // A present value of the wrong type still warns once and writes nothing.
        await act(`${host}.state.count = 'many';`);
        assert.equal((await read()).count, "1");
        const refused = warnings.filter((warning) => warning.includes("HR007"));
        assert.equal(refused.length, 1, refused.join("\n"));
        assert.match(refused[0]!, /count/);
        assert.deepEqual(errors, []);
      } finally { await browser.close(); }
    });
  }
});
