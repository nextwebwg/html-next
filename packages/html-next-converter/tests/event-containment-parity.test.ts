import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, it } from "vitest";

import { compileScript, parse as parseVue } from "@vue/compiler-sfc";
import { build } from "esbuild";
import { chromium, firefox, webkit, type BrowserType, type Page } from "playwright";

import { convertComponents } from "../src/index.js";
import { sveltePlugin } from "./helpers/svelte.js";
import { launchParityBrowser } from "../../html-next/tests/pixel-parity.js";

/**
 * A component that wraps another contains the inner one's events with a capture listener on its own
 * root: capture runs before the event reaches a descendant target, and at the target before
 * non-capture listeners, so `stopImmediatePropagation()` there runs ahead of every listener a
 * consumer added to the root, in whatever order they were added. The wrapper then raises its own event.
 */
const menu = `<template component="x-menu" status="early" summary="Raises select."><defs>
  <event name="select" type="string"></event>
  <handler name="choose"><dispatch event="select" value="b"></dispatch></handler>
</defs><div class="menu"><button type="button" on:click="choose">B</button></div></template>`;
const wrappers = `<link rel="component" href="./menu.html">
<template component="x-picker" status="early" summary="Wraps a menu." controller="./contain.js"><defs>
  <event name="pick" type="string"></event>
</defs><section><x-menu></x-menu></section></template>
<template component="x-picker-root" status="early" summary="Is a menu." controller="./contain.js"><defs>
  <event name="pick" type="string"></event>
</defs><x-menu></x-menu></template>`;
const app = `<link rel="component" href="./wrappers.html">
<template component="x-app" status="early" summary="Both wrappers."><main><x-picker id="wrapped"></x-picker><x-picker-root id="delegated"></x-picker-root></main></template>`;
const controller = `export default function initialize(host) {
  host.on("connect", () => {
    const contain = (event) => {
      event.stopImmediatePropagation();
      host.dispatch("pick", event.detail);
    };
    host.root.addEventListener("select", contain, { capture: true });
    window.contained = (window.contained ?? 0) + 1;
    return () => host.root.removeEventListener("select", contain, { capture: true });
  });
}
`;
const files: Readonly<Record<string, string>> = { "menu.html": menu, "wrappers.html": wrappers, "app.html": app, "contain.js": controller };

const enabled = process.env.HTMLNEXT_TARGET_TEST === "1";
const nodeModules = fileURLToPath(new URL("../node_modules", import.meta.url));
const vuePlugin = { name: "compiled-vue-sfc", setup(pluginBuild: { onResolve: (options: { filter: RegExp }, callback: (args: { path: string; resolveDir: string }) => { path: string }) => void }) {
  pluginBuild.onResolve({ filter: /\.vue$/ }, (args) => ({ path: resolve(args.resolveDir, args.path.replace(/\.vue$/, ".ts")) }));
} };

/** Listeners a consumer adds to each wrapper's root before its controller connects, then one click per wrapper. */
async function observe(page: Page): Promise<unknown> {
  await page.evaluate(() => {
    const log: string[] = [];
    (window as unknown as { log: string[] }).log = log;
    for (const id of ["wrapped", "delegated"]) {
      const root = document.getElementById(id)!;
      root.addEventListener("select", () => log.push(`${id} select`));
      root.addEventListener("pick", (event) => log.push(`${id} pick ${(event as CustomEvent).detail}`));
    }
    document.addEventListener("select", () => log.push("document select"));
  });
  await page.waitForFunction(() => (window as unknown as { contained?: number }).contained === 2);
  // Listeners added after the controller's capture listener are stopped too.
  await page.evaluate(() => {
    const log = (window as unknown as { log: string[] }).log;
    for (const id of ["wrapped", "delegated"]) {
      const root = document.getElementById(id)!;
      root.addEventListener("select", () => log.push(`${id} late select`));
      root.addEventListener("select", () => log.push(`${id} late capture select`), { capture: true });
    }
  });
  for (const id of ["wrapped", "delegated"]) await page.locator(`#${id} button`).click();
  return page.evaluate(() => ({
    log: (window as unknown as { log: string[] }).log,
    roots: ["wrapped", "delegated"].map((id) => document.getElementById(id)!.localName),
  }));
}

describe.skipIf(!enabled)("event containment with a capture listener on the wrapper's root", () => {
  let directory = "";
  const bundles = new Map<string, string>();

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-event-containment-"));
    await symlink(nodeModules, join(directory, "node_modules"), "dir");
    for (const [name, contents] of Object.entries(files)) await writeFile(join(directory, name), contents);
    const live = join(directory, "live.js");
    await build({ entryPoints: [fileURLToPath(new URL("../../html-next/src/browser-loader.ts", import.meta.url))],
      outfile: live, bundle: true, format: "iife", globalName: "HtmlNextLoader", platform: "browser", target: ["es2022"] });
    bundles.set("live", live);
    for (const target of ["vue", "react", "svelte"] as const) {
      const out = join(directory, target);
      const manifest = await convertComponents({ mode: "application", target, root: directory, outDirectory: out, entries: ["app.html"] });
      const artifact = manifest.components.find((component) => component.tag === "x-app")!.artifact;
      const entry = join(out, "entry.ts");
      const bundle = join(out, "bundle.js");
      if (target === "vue") {
        for (const component of manifest.components) {
          const path = join(out, component.artifact);
          const parsed = parseVue(await readFile(path, "utf8"), { filename: path });
          assert.deepEqual(parsed.errors, []);
          await writeFile(path.replace(/\.vue$/, ".ts"), compileScript(parsed.descriptor, { id: component.tag, inlineTemplate: true }).content);
        }
        await writeFile(entry, `import { createApp, h } from "vue"; import XApp from "./${artifact}";
createApp({ render: () => h(XApp) }).mount(document.querySelector("#mount")!);\n`);
        await build({ entryPoints: [entry], outfile: bundle, bundle: true, format: "iife", platform: "browser", target: ["es2022"],
          nodePaths: [nodeModules], plugins: [vuePlugin] });
      } else if (target === "react") {
        await writeFile(join(out, "entry.tsx"), `import { createRoot } from "react-dom/client"; import XApp from "./${artifact}";
createRoot(document.querySelector("#mount")!).render(<XApp />);\n`);
        await build({ entryPoints: [join(out, "entry.tsx")], outfile: bundle, bundle: true, format: "iife", platform: "browser",
          target: ["es2022"], jsx: "automatic", nodePaths: [nodeModules], loader: { ".css": "empty" } });
      } else {
        await writeFile(join(out, "App.svelte"), `<script>import XApp from "./${artifact}";</script><XApp />`);
        await writeFile(entry, `import { mount } from "svelte"; import App from "./App.svelte";
mount(App, { target: document.querySelector("#mount")! });\n`);
        await build({ entryPoints: [entry], outfile: bundle, bundle: true, format: "iife", platform: "browser", target: ["es2022"],
          loader: { ".css": "empty" }, plugins: [sveltePlugin("client")] });
      }
      bundles.set(target, bundle);
    }
  }, 120_000);
  afterAll(async () => { if (directory !== "") await rm(directory, { recursive: true, force: true }); });

  for (const [engine, browserType] of [["Chromium", chromium], ["Firefox", firefox], ["WebKit", webkit]] as const satisfies ReadonlyArray<readonly [string, BrowserType]>) {
    for (const target of ["live", "vue", "react", "svelte"] as const) {
      it(`${engine} ${target} stops the inner event ahead of the root's other listeners`, async () => {
        const browser = await launchParityBrowser(browserType);
        const errors: string[] = [];
        try {
          const page = await browser.newPage();
          page.setDefaultTimeout(10_000);
          page.on("pageerror", (error) => errors.push(error.message));
          page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
          await page.route("https://app.example/**", (route) => {
            const name = new URL(route.request().url()).pathname.slice(1);
            if (Object.hasOwn(files, name)) {
              return route.fulfill({ contentType: name.endsWith(".js") ? "text/javascript" : "text/html", body: files[name]! });
            }
            return route.fulfill({ contentType: "text/html", body: target === "live"
              ? '<link rel="component" href="/app.html"><div id="mount"><x-app></x-app></div>' : '<div id="mount"></div>' });
          });
          await page.goto("https://app.example/");
          await page.addScriptTag({ path: bundles.get(target)! });
          if (target === "live") {
            await page.evaluate(() => (window as unknown as { HtmlNextLoader: { startBrowserComponents(): Promise<unknown> } }).HtmlNextLoader.startBrowserComponents());
          }
          const observed = await page.waitForSelector("#wrapped button").then(() => observe(page)).catch(async (error: unknown) => {
            throw new Error(JSON.stringify({ errors, html: await page.evaluate(() => document.body.innerHTML),
              contained: await page.evaluate(() => (window as unknown as { contained?: number }).contained) }), { cause: error });
          });
          assert.deepEqual(observed, {
            log: ["wrapped pick b", "delegated pick b"],
            roots: ["section", "div"],
          });
          assert.deepEqual(errors, []);
        } finally {
          await browser.close();
        }
      });
    }
  }
});
