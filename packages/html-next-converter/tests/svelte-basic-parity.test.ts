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
const source = `<template component="x-counter" status="early" summary="Counter."><defs>
  <state name="count" type="integer" value="0"></state>
  <computed name="double" from="count * 2"></computed>
  <handler name="increment"><set name="count" expr:value="count + 1"></set></handler>
</defs><button type="button" on:click="increment" from:data-double="double" $value="count"></button>
<style>:host { display: inline-block; padding: 8px; border: 1px solid #444; }</style></template>`;

async function snapshot(page: Page): Promise<{ readonly text: string; readonly doubled: string | null; readonly pixels: Buffer }> {
  await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
  return {
    text: await page.locator("button").innerText(),
    doubled: await page.locator("button").getAttribute("data-double"),
    pixels: await page.locator("button").screenshot({ animations: "disabled" }),
  };
}

describe.skipIf(!enabled)("Svelte basic visual and behavior parity", () => {
  let directory = "";
  let liveBundle = "";
  const outputs = new Map<"application" | "library", { bundle: string; css: string }>();

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-svelte-basic-"));
    await writeFile(join(directory, "counter.html"), source);
    for (const mode of ["application", "library"] as const) {
      const outDirectory = join(directory, mode);
      const manifest = await convertComponents({ mode, target: "svelte", root: directory, outDirectory, entries: ["counter.html"] });
      const component = manifest.components[0]!;
      const componentPath = join(outDirectory, component.artifact);
      const svelteSource = await readFile(componentPath, "utf8");
      const compiled = compile(svelteSource, { filename: componentPath, generate: "client" });
      const compiledPath = join(outDirectory, "svelte", "XCounter.js");
      await writeFile(compiledPath, compiled.js.code);
      const entry = join(outDirectory, "entry.js");
      await writeFile(entry, `import { mount } from "svelte";
import XCounter from "./svelte/XCounter.js";
mount(XCounter, { target: document.querySelector("main") });`);
      const bundle = join(outDirectory, "svelte.js");
      await build({ entryPoints: [entry], outfile: bundle, bundle: true, format: "iife", platform: "browser",
        target: ["es2022"], loader: { ".css": "empty" }, nodePaths: [fileURLToPath(new URL("../node_modules", import.meta.url))] });
      const style = manifest.output.artifacts.find((artifact) => artifact.kind === "style");
      outputs.set(mode, { bundle, css: style === undefined ? "" : await readFile(join(outDirectory, style.path), "utf8") });
    }
    liveBundle = join(directory, "live.js");
    await build({ entryPoints: [fileURLToPath(new URL("../../html-next/src/live.ts", import.meta.url))],
      outfile: liveBundle, bundle: true, format: "iife", globalName: "HtmlRuntime", platform: "browser", target: ["es2022"] });
  });

  afterAll(async () => { if (directory !== "") await rm(directory, { recursive: true, force: true }); });

  for (const [engine, browserType] of [["Chromium", chromium], ["Firefox", firefox], ["WebKit", webkit]] as const satisfies ReadonlyArray<readonly [string, BrowserType]>) {
    for (const mode of ["application", "library"] as const) {
      it(`${engine} ${mode} matches the live runtime before and after a click`, async () => {
        const { bundle, css } = outputs.get(mode)!;
        const browser = await launchParityBrowser(browserType);
        const live = await browser.newPage();
        const svelte = await browser.newPage();
        const errors: string[] = [];
        try {
          for (const page of [live, svelte]) page.on("pageerror", (error) => errors.push(error.message));
          await live.setContent(`${source}<main><x-counter></x-counter></main>`);
          await live.addScriptTag({ path: liveBundle });
          await live.evaluate(() => (window as unknown as { HtmlRuntime: { lowerDocument(): void } }).HtmlRuntime.lowerDocument());
          await svelte.setContent(`<style>${css}</style><main></main>`);
          await svelte.addScriptTag({ path: bundle });
          for (const expected of ["0", "1"]) {
            await Promise.all([live, svelte].map((page) => page.waitForFunction((value) => document.querySelector("button")?.textContent === value, expected)));
            const [native, converted] = await Promise.all([snapshot(live), snapshot(svelte)]);
            assert.equal(converted.text, native.text);
            assert.equal(converted.doubled, native.doubled);
            await assertPixelsEqual(svelte, converted.pixels, native.pixels, "Svelte counter pixels differ", live);
            if (expected === "0") await Promise.all([live, svelte].map((page) => page.locator("button").click()));
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
