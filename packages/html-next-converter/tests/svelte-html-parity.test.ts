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
const source = `<template component="x-safe-html" status="early" summary="Safe dynamic markup."><defs>
  <state name="body" type="string" value="&lt;b&gt;OK&lt;/b&gt;&lt;script&gt;bad()&lt;/script&gt;&lt;a href='javascript:bad()'&gt;Link&lt;/a&gt;"></state>
  <state name="width" type="length" value="8px"></state>
  <handler name="invalidate"><set name="width" value="1rem"></set></handler>
  <handler name="restore"><set name="width" value="2px"></set></handler>
</defs><div><button class="invalidate" type="button" on:click="invalidate">Invalidate</button>
  <button class="restore" type="button" on:click="restore">Restore</button>
  <p class="unsafe" $html="body"></p>
  <p class="element" $html="concat('&lt;b&gt;', min(width, 5px), '&lt;/b&gt;')"></p>
  <span class="inline"><template $html="concat('&lt;i&gt;', min(width, 5px), '&lt;/i&gt;')"></template></span>
</div><style>:host { display: block; width: 240px; padding: 8px; border: 1px solid #444; }</style></template>`;

async function observe(page: Page): Promise<{ readonly behavior: Record<string, unknown>; readonly pixels: Buffer }> {
  await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
  const root = page.locator("div[data-component]");
  const behavior = await root.evaluate((element) => ({
    safeText: element.querySelector(".unsafe")?.textContent,
    scripts: element.querySelectorAll("script").length,
    href: element.querySelector(".unsafe a")?.getAttribute("href") ?? null,
    element: element.querySelector(".element b")?.textContent ?? null,
    inline: element.querySelector(".inline i")?.textContent ?? null,
  }));
  return { behavior, pixels: await root.screenshot({ animations: "disabled" }) };
}

describe.skipIf(!enabled)("Svelte safe-HTML parity", () => {
  let directory = "";
  let liveBundle = "";
  const outputs = new Map<"application" | "library", { bundle: string; css: string }>();

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-svelte-html-"));
    await writeFile(join(directory, "safe.html"), source);
    liveBundle = join(directory, "live.js");
    await build({ entryPoints: [fileURLToPath(new URL("../../html-next/src/live.ts", import.meta.url))], outfile: liveBundle,
      bundle: true, format: "iife", globalName: "HtmlRuntime", platform: "browser", target: ["es2022"] });
    for (const mode of ["application", "library"] as const) {
      const outDirectory = join(directory, mode);
      const manifest = await convertComponents({ mode, target: "svelte", entries: ["safe.html"], root: directory, outDirectory });
      const component = manifest.components[0]!;
      const path = join(outDirectory, component.artifact);
      await writeFile(join(outDirectory, "svelte", `${component.name}.js`),
        compile(await readFile(path, "utf8"), { filename: path, generate: "client" }).js.code);
      const entry = join(outDirectory, "entry.js");
      await writeFile(entry, `import { mount } from "svelte"; import Component from "./svelte/${component.name}.js";
mount(Component, { target: document.querySelector("main") });`);
      const bundle = join(outDirectory, "svelte.js");
      await build({ entryPoints: [entry], outfile: bundle, bundle: true, format: "iife", platform: "browser", target: ["es2022"],
        loader: { ".css": "empty" }, nodePaths: [fileURLToPath(new URL("../node_modules", import.meta.url))] });
      const style = manifest.output.artifacts.find((artifact) => artifact.kind === "style");
      outputs.set(mode, { bundle, css: style === undefined ? "" : await readFile(join(outDirectory, style.path), "utf8") });
    }
  });

  afterAll(async () => { if (directory !== "") await rm(directory, { recursive: true, force: true }); });

  for (const [engine, browserType] of [["Chromium", chromium], ["Firefox", firefox], ["WebKit", webkit]] as const satisfies ReadonlyArray<readonly [string, BrowserType]>) {
    for (const mode of ["application", "library"] as const) {
      it(`${engine} ${mode} sanitizes and retains the last valid markup`, async () => {
        const browser = await launchParityBrowser(browserType);
        const live = await browser.newPage();
        const svelte = await browser.newPage();
        const errors: string[] = [];
        try {
          for (const page of [live, svelte]) page.on("pageerror", (error) => errors.push(error.message));
          await live.setContent(`${source}<main><x-safe-html></x-safe-html></main>`);
          await live.addScriptTag({ path: liveBundle });
          await live.evaluate(() => (window as unknown as { HtmlRuntime: { lowerDocument(): void } }).HtmlRuntime.lowerDocument());
          const output = outputs.get(mode)!;
          await svelte.setContent(`<style>${output.css}</style><main></main>`);
          await svelte.addScriptTag({ path: output.bundle });
          await svelte.locator(".element b").waitFor();
          for (const [index, expected] of ["5px", "5px", "2px"].entries()) {
            if (index === 1) await Promise.all([live, svelte].map((page) => page.locator(".invalidate").click()));
            if (index === 2) await Promise.all([live, svelte].map((page) => page.locator(".restore").click()));
            if (index === 2) await Promise.all([live, svelte].map((page) => page.waitForFunction((value) =>
              document.querySelector(".element b")?.textContent === value, expected)));
            const [native, converted] = await Promise.all([observe(live), observe(svelte)]);
            assert.deepEqual(converted.behavior, native.behavior);
            assert.equal(converted.behavior.element, expected);
            await assertPixelsEqual(svelte, converted.pixels, native.pixels, "Svelte safe-HTML pixels differ", live);
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
