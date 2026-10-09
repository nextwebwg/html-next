import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, it } from "vitest";
import { build } from "esbuild";
import { compileSvelteFile, sveltePlugin, svelteStyles } from "./helpers/svelte.js";
import { chromium, firefox, webkit, type BrowserType, type Page } from "playwright";

import { assertPixelsEqual, launchParityBrowser } from "../../html-next/tests/pixel-parity.js";
import { convertComponents } from "../src/index.js";

const enabled = process.env.HTMLNEXT_TARGET_TEST === "1";
const source = `<template component="x-controls" status="early" summary="Bound native controls."><defs>
  <state name="draft" type="string" value="Ready"></state>
  <state name="done" type="boolean" value="false"></state>
  <state name="choice" type="string" value="b"></state>
</defs><section><input class="text" type="text" bind:value="draft">
  <input class="check" type="checkbox" bind:checked="done">
  <select class="choice" bind:value="choice"><option value="a">A</option><option value="b">B</option></select>
  <output $value="concat($draft, $done ? ' yes ' : ' no ', $choice)"></output></section>
<style>:host { display: block; width: 200px; padding: 8px; border: 1px solid #444; }</style></template>`;

async function observe(page: Page): Promise<{ readonly behavior: Record<string, unknown>; readonly pixels: Buffer }> {
  await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
  const root = page.locator("section");
  const behavior = await root.evaluate((element) => ({
    value: element.querySelector<HTMLInputElement>(".text")?.value,
    checked: element.querySelector<HTMLInputElement>(".check")?.checked,
    choice: element.querySelector<HTMLSelectElement>(".choice")?.value,
    output: element.querySelector("output")?.textContent,
  }));
  return { behavior, pixels: await root.screenshot({ animations: "disabled" }) };
}

describe.skipIf(!enabled)("Svelte native-control binding parity", () => {
  let directory = "";
  let liveBundle = "";
  const outputs = new Map<"application" | "library", { bundle: string; css: string }>();

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-svelte-controls-"));
    await writeFile(join(directory, "controls.html"), source);
    liveBundle = join(directory, "live.js");
    await build({ entryPoints: [fileURLToPath(new URL("../../html-next/src/live.ts", import.meta.url))], outfile: liveBundle,
      bundle: true, format: "iife", globalName: "HtmlRuntime", platform: "browser", target: ["es2022"] });
    for (const mode of ["application", "library"] as const) {
      const outDirectory = join(directory, mode);
      const manifest = await convertComponents({ mode, target: "svelte", entries: ["controls.html"], root: directory, outDirectory });
      const component = manifest.components[0]!;
      const path = join(outDirectory, component.artifact);
      await writeFile(join(outDirectory, "svelte", `${component.name}.js`),
        await compileSvelteFile(path));
      const entry = join(outDirectory, "entry.js");
      await writeFile(entry, `import { mount } from "svelte"; import Component from "./svelte/${component.name}.js";
mount(Component, { target: document.querySelector("main") });`);
      const bundle = join(outDirectory, "svelte.js");
      await build({ entryPoints: [entry], outfile: bundle, bundle: true, format: "iife", platform: "browser", target: ["es2022"],
        loader: { ".css": "empty" }, plugins: [sveltePlugin("client")], nodePaths: [fileURLToPath(new URL("../node_modules", import.meta.url))] });
      outputs.set(mode, { bundle, css: svelteStyles(outDirectory) });
    }
  });

  afterAll(async () => { if (directory !== "") await rm(directory, { recursive: true, force: true }); });

  for (const [engine, browserType] of [["Chromium", chromium], ["Firefox", firefox], ["WebKit", webkit]] as const satisfies ReadonlyArray<readonly [string, BrowserType]>) {
    for (const mode of ["application", "library"] as const) {
      it(`${engine} ${mode} edits text and checkbox state with matching pixels`, async () => {
        const browser = await launchParityBrowser(browserType);
        const live = await browser.newPage();
        const svelte = await browser.newPage();
        const errors: string[] = [];
        try {
          for (const page of [live, svelte]) page.on("pageerror", (error) => errors.push(error.message));
          await live.setContent(`${source}<main><x-controls></x-controls></main>`);
          await live.addScriptTag({ path: liveBundle });
          await live.evaluate(() => (window as unknown as { HtmlRuntime: { lowerDocument(): void } }).HtmlRuntime.lowerDocument());
          const output = outputs.get(mode)!;
          await svelte.setContent(`<style>${output.css}</style><main></main>`);
          await svelte.addScriptTag({ path: output.bundle });
          for (const expected of ["Ready no b", "Edited no b", "Edited yes b", "Edited yes a"]) {
            await Promise.all([live, svelte].map((page) => page.waitForFunction((value) =>
              document.querySelector("output")?.textContent === value, expected)));
            const [native, converted] = await Promise.all([observe(live), observe(svelte)]);
            assert.deepEqual(converted.behavior, native.behavior);
            await assertPixelsEqual(svelte, converted.pixels, native.pixels, "Svelte native-control pixels differ", live);
            if (expected === "Ready no b") await Promise.all([live, svelte].map((page) => page.locator(".text").fill("Edited")));
            if (expected === "Edited no b") await Promise.all([live, svelte].map((page) => page.locator(".check").check()));
            if (expected === "Edited yes b") await Promise.all([live, svelte].map((page) => page.locator(".choice").selectOption("a")));
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
