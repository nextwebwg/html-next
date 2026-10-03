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

const fixtures = [
  {
    name: "counter",
    source: `<template component="x-counter" status="early" summary="Counter."><defs>
      <state name="count" type="integer" value="0"></state>
      <computed name="double" from="count * 2"></computed>
      <handler name="increment"><set name="count" expr:value="count + 1"></set></handler>
    </defs><button type="button" on:click="increment" from:data-double="double" $value="count"></button>
    <style>:host { display: inline-block; padding: 8px; border: 1px solid #444; }</style></template>`,
    tag: "x-counter",
    root: "button",
    checkpoint: "button",
    expectedText: ["0", "1"],
    click: "button",
    probe: async (page: Page) => ({
      text: await page.locator("button").innerText(),
      doubled: await page.locator("button").getAttribute("data-double"),
    }),
  },
  {
    name: "list",
    source: `<template component="x-list" status="early" summary="List."><defs>
      <state name="rows" type="list(integer)" value="[3, 1, 2]"></state>
      <handler name="change"><set name="rows" expr:value="[2, 4, 1]"></set></handler>
    </defs><div><button type="button" on:click="change">Change</button><ul>
      <li $each="row, i of rows" $key="row" $sort="row" from:data-i="i" from:data-count="loop.count" $value="row"></li>
    </ul></div><style>:host { display: inline-block; padding: 8px; border: 1px solid #444; }</style></template>`,
    tag: "x-list",
    root: "div",
    checkpoint: "ul",
    expectedText: ["123", "124"],
    click: "button",
    probe: async (page: Page) => ({
      rows: await page.locator("ul li").evaluateAll((items) => items.map((item) => [
        item.textContent, item.getAttribute("data-i"), item.getAttribute("data-count"),
      ])),
    }),
  },
] as const;

type Fixture = (typeof fixtures)[number];

async function snapshot(page: Page, fixture: Fixture): Promise<{ readonly data: unknown; readonly pixels: Buffer }> {
  await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
  return { data: await fixture.probe(page), pixels: await page.locator(fixture.root).screenshot({ animations: "disabled" }) };
}

describe.skipIf(!enabled)("Svelte basic visual and behavior parity", () => {
  let directory = "";
  let liveBundle = "";
  const outputs = new Map<string, { bundle: string; css: string }>();

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-svelte-basic-"));
    for (const fixture of fixtures) {
      await writeFile(join(directory, `${fixture.name}.html`), fixture.source);
      for (const mode of ["application", "library"] as const) {
        const outDirectory = join(directory, fixture.name, mode);
        const manifest = await convertComponents({ mode, target: "svelte", root: directory, outDirectory,
          entries: [`${fixture.name}.html`] });
        const component = manifest.components[0]!;
        const componentPath = join(outDirectory, component.artifact);
        const svelteSource = await readFile(componentPath, "utf8");
        const compiled = compile(svelteSource, { filename: componentPath, generate: "client" });
        const compiledPath = join(outDirectory, "svelte", `${component.name}.js`);
        await writeFile(compiledPath, compiled.js.code);
        const entry = join(outDirectory, "entry.js");
        await writeFile(entry, `import { mount } from "svelte";
import Component from "./svelte/${component.name}.js";
mount(Component, { target: document.querySelector("main") });`);
        const bundle = join(outDirectory, "svelte.js");
        await build({ entryPoints: [entry], outfile: bundle, bundle: true, format: "iife", platform: "browser",
          target: ["es2022"], loader: { ".css": "empty" }, nodePaths: [fileURLToPath(new URL("../node_modules", import.meta.url))] });
        const style = manifest.output.artifacts.find((artifact) => artifact.kind === "style");
        outputs.set(`${fixture.name}:${mode}`, { bundle,
          css: style === undefined ? "" : await readFile(join(outDirectory, style.path), "utf8") });
      }
    }
    liveBundle = join(directory, "live.js");
    await build({ entryPoints: [fileURLToPath(new URL("../../html-next/src/live.ts", import.meta.url))],
      outfile: liveBundle, bundle: true, format: "iife", globalName: "HtmlRuntime", platform: "browser", target: ["es2022"] });
  });

  afterAll(async () => { if (directory !== "") await rm(directory, { recursive: true, force: true }); });

  for (const fixture of fixtures) {
    for (const [engine, browserType] of [["Chromium", chromium], ["Firefox", firefox], ["WebKit", webkit]] as const satisfies ReadonlyArray<readonly [string, BrowserType]>) {
      for (const mode of ["application", "library"] as const) {
        it(`${engine} ${mode} ${fixture.name} matches the live runtime before and after a click`, async () => {
          const { bundle, css } = outputs.get(`${fixture.name}:${mode}`)!;
          const browser = await launchParityBrowser(browserType);
          const live = await browser.newPage();
          const svelte = await browser.newPage();
          const errors: string[] = [];
          try {
            for (const page of [live, svelte]) page.on("pageerror", (error) => errors.push(error.message));
            await live.setContent(`${fixture.source}<main><${fixture.tag}></${fixture.tag}></main>`);
            await live.addScriptTag({ path: liveBundle });
            await live.evaluate(() => (window as unknown as { HtmlRuntime: { lowerDocument(): void } }).HtmlRuntime.lowerDocument());
            await svelte.setContent(`<style>${css}</style><main></main>`);
            await svelte.addScriptTag({ path: bundle });
            for (const [index, expected] of fixture.expectedText.entries()) {
              await Promise.all([live, svelte].map((page) => page.waitForFunction(({ selector, text }) =>
                document.querySelector(selector)?.textContent === text, { selector: fixture.checkpoint, text: expected })));
              const [native, converted] = await Promise.all([snapshot(live, fixture), snapshot(svelte, fixture)]);
              assert.deepEqual(converted.data, native.data);
              await assertPixelsEqual(svelte, converted.pixels, native.pixels, `Svelte ${fixture.name} pixels differ`, live);
              if (index === 0) await Promise.all([live, svelte].map((page) => page.locator(fixture.click).click()));
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
  }
});
