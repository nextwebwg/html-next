import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, it } from "vitest";
import { build } from "esbuild";
import { chromium, firefox, webkit, type BrowserType, type Page } from "playwright";
import { compile } from "svelte/compiler";

import { assertPixelsEqual, launchParityBrowser } from "../../html-next/tests/pixel-parity.js";
import { convertComponents } from "../src/index.js";

const enabled = process.env.HTMLNEXT_TARGET_TEST === "1";
const source = `<template component="x-required-number" status="early" summary="Required numeric prop."><defs>
  <prop name="n" type="number" required>Number.</prop>
</defs><div from:data-n="$n"><output from:data-sum="$n + 1" $value="$n + 1"></output></div></template>`;

async function observe(page: Page): Promise<{ readonly behavior: {
  readonly value: string | null; readonly sum: string | null; readonly output: string | null;
  readonly valid: boolean; readonly valueMissing: boolean; readonly badInput: boolean;
}; readonly pixels: Buffer }> {
  await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
  const root = page.locator("#case");
  const behavior = await root.evaluate((element) => {
    const validity = (element as unknown as Element & { validity: ValidityState }).validity;
    return {
      value: element.getAttribute("data-n"),
      sum: element.querySelector("output")?.getAttribute("data-sum") ?? null,
      output: element.querySelector("output")?.textContent ?? null,
      valid: validity.valid,
      valueMissing: validity.valueMissing,
      badInput: validity.badInput,
    };
  });
  return { behavior, pixels: await page.screenshot({ animations: "disabled" }) };
}

describe.skipIf(!enabled)("Svelte typed-prop parity", () => {
  let directory = "";
  let liveBundle = "";
  const bundles = new Map<"application" | "library", string>();

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-svelte-props-"));
    await writeFile(join(directory, "number.html"), source);
    liveBundle = join(directory, "live.js");
    await build({ entryPoints: [fileURLToPath(new URL("../../html-next/src/live.ts", import.meta.url))], outfile: liveBundle,
      bundle: true, format: "iife", globalName: "HtmlRuntime", platform: "browser", target: ["es2022"] });
    for (const mode of ["application", "library"] as const) {
      const outDirectory = join(directory, mode);
      const manifest = await convertComponents({ mode, target: "svelte", entries: ["number.html"], root: directory, outDirectory });
      const component = manifest.components[0]!;
      const componentSource = await readFile(join(outDirectory, component.artifact), "utf8");
      const compiled = compile(componentSource, { filename: component.artifact, generate: "client" });
      await writeFile(join(outDirectory, "svelte", `${component.name}.js`), compiled.js.code);
      const wrapper = `<script lang="ts">
import Component from "./svelte/${component.name}.js";
let n = $state<unknown>(42);
(globalThis as typeof globalThis & { svelteSetN: (value: unknown) => void }).svelteSetN = (value) => { n = value; };
</script>
<Component id="case" {n} />`;
      await writeFile(join(outDirectory, "App.js"), compile(wrapper, { filename: "App.svelte", generate: "client" }).js.code);
      const entry = join(outDirectory, "entry.js");
      await writeFile(entry, 'import { mount } from "svelte"; import App from "./App.js"; mount(App, { target: document.querySelector("main") });');
      const bundle = join(outDirectory, "svelte.js");
      await build({ entryPoints: [entry], outfile: bundle, bundle: true, format: "iife", platform: "browser", target: ["es2022"],
        loader: { ".css": "empty" }, nodePaths: [fileURLToPath(new URL("../node_modules", import.meta.url))] });
      bundles.set(mode, bundle);
    }
  });

  afterAll(async () => { if (directory !== "") await rm(directory, { recursive: true, force: true }); });

  for (const [engine, browserType] of [["Chromium", chromium], ["Firefox", firefox], ["WebKit", webkit]] as const satisfies ReadonlyArray<readonly [string, BrowserType]>) {
    for (const mode of ["application", "library"] as const) {
      it(`${engine} ${mode} rejects invalid updates while retaining the last valid rendering`, async () => {
        const browser = await launchParityBrowser(browserType);
        const live = await browser.newPage();
        const svelte = await browser.newPage();
        const errors: string[] = [];
        try {
          for (const page of [live, svelte]) page.on("pageerror", (error) => errors.push(error.message));
          await live.setContent(`${source}<main><x-required-number id="case" n="42"></x-required-number></main>`);
          await live.addScriptTag({ path: liveBundle });
          await live.evaluate(() => (window as unknown as { HtmlRuntime: { lowerDocument(): void } }).HtmlRuntime.lowerDocument());
          await svelte.setContent("<main></main>");
          await svelte.addScriptTag({ path: bundles.get(mode)! });
          await svelte.locator("#case").waitFor();
          for (const [index, value] of [42, "bad", 43].entries()) {
            if (index > 0) {
              await live.evaluate((next) => (window as unknown as { HtmlRuntime: { updateComponentProps(root: Element, props: Record<string, unknown>): void } })
                .HtmlRuntime.updateComponentProps(document.querySelector("#case")!, { n: next }), value);
              await svelte.evaluate((next) => (window as unknown as { svelteSetN(value: unknown): void }).svelteSetN(next), value);
            }
            const [native, converted] = await Promise.all([observe(live), observe(svelte)]);
            assert.deepEqual(converted.behavior, native.behavior);
            await assertPixelsEqual(svelte, converted.pixels, native.pixels, "Svelte prop pixels differ", live);
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
