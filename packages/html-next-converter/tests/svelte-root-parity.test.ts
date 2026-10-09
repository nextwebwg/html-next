import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, it } from "vitest";
import { build } from "esbuild";
import { sveltePlugin } from "./helpers/svelte.js";
import { chromium, firefox, webkit, type BrowserType, type Page } from "playwright";
import { compile } from "svelte/compiler";

import { assertPixelsEqual, launchParityBrowser } from "../../html-next/tests/pixel-parity.js";
import { convertComponents } from "../src/index.js";

const enabled = process.env.HTMLNEXT_TARGET_TEST === "1";
const source = `<template component="x-action" status="early" summary="Button or link."><defs>
  <prop name="as" type="keyword" values="button, a" default="button">Root.</prop>
  <prop name="href" type="string">Destination.</prop>
</defs><template $match><a $when="$as = 'a'" class="action" from:href="$href">Go</a>
<button $else class="action" type="button">Go</button></template>
<style>:host { display: inline-block; padding: 8px; border: 1px solid #444; }
  :host([as="a"]) { background: rgb(240, 240, 240); }</style></template>`;

async function observe(page: Page): Promise<{ readonly behavior: Record<string, string | null>; readonly pixels: Buffer }> {
  await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
  const root = page.locator("#case");
  const behavior = await root.evaluate((element) => ({
    tag: element.localName,
    component: element.getAttribute("data-component"),
    className: element.getAttribute("class"),
    href: element.getAttribute("href"),
    type: element.getAttribute("type"),
    as: element.getAttribute("data-as"),
    hostState: element.getAttribute("data-x-action-state"),
    text: element.textContent,
  }));
  return { behavior, pixels: await root.screenshot({ animations: "disabled" }) };
}

describe.skipIf(!enabled)("Svelte root-selection parity", () => {
  let directory = "";
  let liveBundle = "";
  const outputs = new Map<"application" | "library", { bundle: string; css: string }>();

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-svelte-root-"));
    await writeFile(join(directory, "action.html"), source);
    liveBundle = join(directory, "live.js");
    await build({ entryPoints: [fileURLToPath(new URL("../../html-next/src/live.ts", import.meta.url))], outfile: liveBundle,
      bundle: true, format: "iife", globalName: "HtmlRuntime", platform: "browser", target: ["es2022"] });
    for (const mode of ["application", "library"] as const) {
      const outDirectory = join(directory, mode);
      const manifest = await convertComponents({ mode, target: "svelte", entries: ["action.html"], root: directory, outDirectory });
      const component = manifest.components[0]!;
      const path = join(outDirectory, component.artifact);
      await writeFile(join(outDirectory, "svelte", `${component.name}.js`),
        compile(await readFile(path, "utf8"), { filename: path, generate: "client" }).js.code);
      const wrapper = `<script lang="ts">
import Component from "./svelte/${component.name}.js";
let as = $state("button");
(globalThis as typeof globalThis & { svelteSetAs: (value: string) => void }).svelteSetAs = (value) => { as = value; };
</script>
<Component id="case" {as} href="#next" />`;
      await writeFile(join(outDirectory, "App.js"), compile(wrapper, { filename: "App.svelte", generate: "client" }).js.code);
      const entry = join(outDirectory, "entry.js");
      await writeFile(entry, 'import { mount } from "svelte"; import App from "./App.js"; mount(App, { target: document.querySelector("main") });');
      const bundle = join(outDirectory, "svelte.js");
      await build({ entryPoints: [entry], outfile: bundle, bundle: true, format: "iife", platform: "browser", target: ["es2022"],
        loader: { ".css": "empty" }, plugins: [sveltePlugin("client")], nodePaths: [fileURLToPath(new URL("../node_modules", import.meta.url))] });
      const style = manifest.output.artifacts.find((artifact) => artifact.kind === "style");
      outputs.set(mode, { bundle, css: style === undefined ? "" : await readFile(join(outDirectory, style.path), "utf8") });
    }
  });

  afterAll(async () => { if (directory !== "") await rm(directory, { recursive: true, force: true }); });

  for (const [engine, browserType] of [["Chromium", chromium], ["Firefox", firefox], ["WebKit", webkit]] as const satisfies ReadonlyArray<readonly [string, BrowserType]>) {
    for (const mode of ["application", "library"] as const) {
      it(`${engine} ${mode} keeps root attributes and pixels when the selected element changes`, async () => {
        const browser = await launchParityBrowser(browserType);
        const live = await browser.newPage();
        const svelte = await browser.newPage();
        const errors: string[] = [];
        try {
          for (const page of [live, svelte]) page.on("pageerror", (error) => errors.push(error.message));
          await live.setContent(`${source}<main><x-action id="case" as="button" href="#next"></x-action></main>`);
          await live.addScriptTag({ path: liveBundle });
          await live.evaluate(() => (window as unknown as { HtmlRuntime: { lowerDocument(): void } }).HtmlRuntime.lowerDocument());
          const output = outputs.get(mode)!;
          await svelte.setContent(`<style>${output.css}</style><main></main>`);
          await svelte.addScriptTag({ path: output.bundle });
          await svelte.locator("#case").waitFor();
          for (const [index, as] of ["button", "a", "button"].entries()) {
            if (index > 0) {
              await live.evaluate((value) => (window as unknown as { HtmlRuntime: { updateComponentProps(root: Element, props: Record<string, unknown>): void } })
                .HtmlRuntime.updateComponentProps(document.querySelector("#case")!, { as: value }), as);
              await svelte.evaluate((value) => (window as unknown as { svelteSetAs(value: string): void }).svelteSetAs(value), as);
            }
            await Promise.all([live, svelte].map((page) => page.waitForFunction((tag) => document.querySelector("#case")?.localName === tag, as)));
            const [native, converted] = await Promise.all([observe(live), observe(svelte)]);
            assert.deepEqual(converted.behavior, native.behavior);
            await assertPixelsEqual(svelte, converted.pixels, native.pixels, "Svelte selected-root pixels differ", live);
          }
          assert.deepEqual(errors, []);
        } finally {
          await live.close();
          await svelte.close();
          await browser.close();
        }
      });
    }
  }
});
