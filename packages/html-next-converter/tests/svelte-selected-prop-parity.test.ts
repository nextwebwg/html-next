import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, it } from "vitest";
import { build } from "esbuild";
import { compileSvelteFile, sveltePlugin } from "./helpers/svelte.js";
import { chromium, firefox, webkit, type BrowserType, type Page } from "playwright";
import { compile } from "svelte/compiler";

import { assertPixelsEqual, launchParityBrowser } from "../../html-next/tests/pixel-parity.js";
import { convertComponents } from "../src/index.js";

const enabled = process.env.HTMLNEXT_TARGET_TEST === "1";
const source = `<template component="x-selected" status="early" summary="Selected value."><defs>
  <prop name="kind" type="keyword" values="text, number" default="text">Kind.</prop>
  <prop name="value">Value.<type from="kind"><option value="text" type="string"></option><option value="number" type="number"></option></type></prop>
</defs><output from:data-kind="$kind" from:data-value="$value" $value="$value"></output></template>`;

async function observe(page: Page): Promise<{ readonly behavior: Record<string, unknown>; readonly pixels: Buffer }> {
  await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
  const root = page.locator("#case");
  const behavior = await root.evaluate((element) => {
    const validity = (element as unknown as HTMLOutputElement).validity;
    return {
      kind: element.getAttribute("data-kind"), value: element.getAttribute("data-value"), text: element.textContent,
      valid: validity.valid, badInput: validity.badInput,
    };
  });
  return { behavior, pixels: await root.screenshot({ animations: "disabled" }) };
}

describe.skipIf(!enabled)("Svelte selected-prop parity", () => {
  let directory = "";
  let liveBundle = "";
  const bundles = new Map<"application" | "library", string>();

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-svelte-selected-"));
    await writeFile(join(directory, "selected.html"), source);
    liveBundle = join(directory, "live.js");
    await build({ entryPoints: [fileURLToPath(new URL("../../html-next/src/live.ts", import.meta.url))], outfile: liveBundle,
      bundle: true, format: "iife", globalName: "HtmlRuntime", platform: "browser", target: ["es2022"] });
    for (const mode of ["application", "library"] as const) {
      const outDirectory = join(directory, mode);
      const manifest = await convertComponents({ mode, target: "svelte", entries: ["selected.html"], root: directory, outDirectory });
      const component = manifest.components[0]!;
      const componentPath = join(outDirectory, component.artifact);
      await writeFile(join(outDirectory, "svelte", `${component.name}.js`),
        await compileSvelteFile(componentPath));
      const wrapper = `<script lang="ts">
import Component from "./svelte/${component.name}.js";
let selected = $state<{ kind: string; value: unknown }>({ kind: "number", value: 2 });
(globalThis as typeof globalThis & { svelteSetSelected: (kind: string, value: unknown) => void }).svelteSetSelected = (kind, value) => {
  selected = { kind, value };
};
</script>
<Component id="case" kind={selected.kind} value={selected.value} />`;
      await writeFile(join(outDirectory, "App.js"), compile(wrapper, { filename: "App.svelte", generate: "client" }).js.code);
      const entry = join(outDirectory, "entry.js");
      await writeFile(entry, 'import { mount } from "svelte"; import App from "./App.js"; mount(App, { target: document.querySelector("main") });');
      const bundle = join(outDirectory, "svelte.js");
      await build({ entryPoints: [entry], outfile: bundle, bundle: true, format: "iife", platform: "browser", target: ["es2022"],
        loader: { ".css": "empty" }, plugins: [sveltePlugin("client")], nodePaths: [fileURLToPath(new URL("../node_modules", import.meta.url))] });
      bundles.set(mode, bundle);
    }
  });

  afterAll(async () => { if (directory !== "") await rm(directory, { recursive: true, force: true }); });

  for (const [engine, browserType] of [["Chromium", chromium], ["Firefox", firefox], ["WebKit", webkit]] as const satisfies ReadonlyArray<readonly [string, BrowserType]>) {
    for (const mode of ["application", "library"] as const) {
      it(`${engine} ${mode} checks values after selector changes and invalid updates`, async () => {
        const browser = await launchParityBrowser(browserType);
        const live = await browser.newPage();
        const svelte = await browser.newPage();
        const errors: string[] = [];
        try {
          for (const page of [live, svelte]) page.on("pageerror", (error) => errors.push(error.message));
          await live.setContent(`${source}<main><x-selected id="case" kind="number" value="2"></x-selected></main>`);
          await live.addScriptTag({ path: liveBundle });
          await live.evaluate(() => (window as unknown as { HtmlRuntime: { lowerDocument(): void } }).HtmlRuntime.lowerDocument());
          await svelte.setContent("<main></main>");
          await svelte.addScriptTag({ path: bundles.get(mode)! });
          await svelte.locator("#case").waitFor();
          const changes: readonly (readonly [string, unknown])[] = [
            ["number", 2], ["number", "bad"], ["text", "Ada"], ["number", 3],
          ];
          for (const [index, [kind, value]] of changes.entries()) {
            if (index > 0) {
              await live.evaluate(([nextKind, nextValue]: readonly [string, unknown]) => (window as unknown as { HtmlRuntime: {
                updateComponentProps(root: Element, props: Record<string, unknown>): void;
              } }).HtmlRuntime.updateComponentProps(document.querySelector("#case")!, { kind: nextKind, value: nextValue }), [kind, value] as const);
              await svelte.evaluate(([nextKind, nextValue]: readonly [string, unknown]) => (window as unknown as {
                svelteSetSelected(kind: string, value: unknown): void;
              }).svelteSetSelected(nextKind, nextValue), [kind, value] as const);
            }
            const [native, converted] = await Promise.all([observe(live), observe(svelte)]);
            assert.deepEqual(converted.behavior, native.behavior);
            await assertPixelsEqual(svelte, converted.pixels, native.pixels, "Svelte selected-prop pixels differ", live);
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
