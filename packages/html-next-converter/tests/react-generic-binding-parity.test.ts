import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, it } from "vitest";

import { build } from "esbuild";
import { createElement, type ComponentType } from "react";
import { renderToString } from "react-dom/server";
import { chromium, firefox, webkit, type BrowserType, type Page } from "playwright";

import { convertComponents } from "../src/index.js";
import { assertPixelsEqual, launchParityBrowser } from "../../html-next/tests/pixel-parity.js";

const field = `<template component="x-field" status="early" summary="Text field."><defs>
  <prop name="value" type="string" default="">Value.</prop>
</defs><input type="text" from:value="$value"></template>`;
const form = `<template component="x-form" status="early" summary="Generic binding."><defs>
  <state name="name" value="Ada"></state>
</defs><section><x-field bind:value="name"></x-field><output bind:value="name"></output><span $value="$name"></span></section>
<style>:host { display: block; padding: 4px; font: 16px/24px Arial, sans-serif; }</style></template>`;

async function snapshot(page: Page) {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  return {
    behavior: await page.locator("section").evaluate((root) => ({
      input: root.querySelector("input")?.value,
      outputAttribute: root.querySelector("output")?.getAttribute("value"),
      outputValue: root.querySelector("output")?.value,
      text: root.querySelector("span")?.textContent,
    })),
    pixels: await page.locator("section").screenshot({ animations: "disabled" }),
  };
}

describe.skipIf(process.env.HTMLNEXT_TARGET_TEST !== "1")("React generic two-way binding parity", () => {
  let directory = "";
  let liveBundle = "";
  let reactBundle = "";
  let serverMarkup = "";
  let css = "";

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-react-generic-binding-"));
    await writeFile(join(directory, "field.html"), field);
    await writeFile(join(directory, "form.html"), `<link rel="component" href="./field.html">${form}`);
    const outDirectory = join(directory, "out");
    const manifest = await convertComponents({ mode: "application", target: "react", root: directory, outDirectory, entries: ["*.html"] });
    css = (await Promise.all(manifest.output.artifacts.filter((artifact) => artifact.kind === "style")
      .map((artifact) => readFile(join(outDirectory, artifact.path), "utf8")))).join("\n");
    const entry = join(outDirectory, "mount.tsx");
    await writeFile(entry, `import React from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import { XForm } from "./react/application";
const mount = document.querySelector("main")!;
const element = <XForm />;
if (mount.hasChildNodes()) hydrateRoot(mount, element);
else createRoot(mount).render(element);`);
    reactBundle = join(outDirectory, "mount.js");
    await build({ entryPoints: [entry], outfile: reactBundle, bundle: true, format: "iife", platform: "browser",
      target: ["es2022"], jsx: "automatic", loader: { ".css": "empty" },
      nodePaths: [fileURLToPath(new URL("../node_modules", import.meta.url))] });
    const server = await build({ entryPoints: [join(outDirectory, manifest.output.entry)], bundle: true, write: false,
      platform: "node", format: "cjs", jsx: "automatic", packages: "external", loader: { ".css": "empty" } });
    const module = { exports: {} as Record<string, ComponentType<Record<string, unknown>>> };
    new Function("require", "module", "exports", server.outputFiles[0]!.text)(createRequire(import.meta.url), module, module.exports);
    serverMarkup = renderToString(createElement(module.exports.XForm!));
    assert.match(serverMarkup, /<input\b[^>]*value="Ada"/);
    liveBundle = join(directory, "live.js");
    await build({ entryPoints: [fileURLToPath(new URL("../../html-next/src/live.ts", import.meta.url))],
      outfile: liveBundle, bundle: true, format: "iife", globalName: "HtmlRuntime", platform: "browser", target: ["es2022"] });
  });

  afterAll(async () => { if (directory !== "") await rm(directory, { recursive: true, force: true }); });

  for (const [engine, browserType] of [["Chromium", chromium], ["Firefox", firefox], ["WebKit", webkit]] as const satisfies ReadonlyArray<readonly [string, BrowserType]>) {
    for (const hydrate of [false, true]) {
      it(`${engine} ${hydrate ? "hydration" : "mount"} matches nested and ordinary element bindings`, async () => {
        const browser = await launchParityBrowser(browserType);
        const pages: Page[] = [];
        const errors: string[] = [];
        const warnings: string[] = [];
        try {
          const live = await browser.newPage(); pages.push(live);
          const react = await browser.newPage(); pages.push(react);
          react.on("console", (message) => { if (message.type() === "warning" || message.type() === "error") warnings.push(message.text()); });
          for (const page of pages) page.on("pageerror", (error) => errors.push(error.message));
          await live.setContent(`${field}${form}<main><x-form></x-form></main>`);
          await live.addScriptTag({ path: liveBundle });
          await live.evaluate(() => (window as unknown as { HtmlRuntime: { lowerDocument(): void } }).HtmlRuntime.lowerDocument());
          await react.setContent(`<style>${css}</style><main>${hydrate ? serverMarkup : ""}</main>`);
          await react.addScriptTag({ path: reactBundle });
          await Promise.all(pages.map((page) => page.locator("section input").waitFor()));
          for (const [index, expected] of ["Ada", "Bea", "Cy"].entries()) {
            try {
              await Promise.all(pages.map((page) => page.waitForFunction((name) => document.querySelector("section span")?.textContent === name, expected, { timeout: 3000 })));
            } catch (error) {
              const state = await Promise.all(pages.map((page) => page.locator("section").evaluate((root) => ({
                html: root.outerHTML,
                input: root.querySelector("input")?.value,
                output: root.querySelector("output")?.value,
              }))));
              throw new Error(`Waiting for ${expected}: ${JSON.stringify({ state, errors, warnings })}`, { cause: error });
            }
            const [native, converted] = await Promise.all([snapshot(live), snapshot(react)]);
            assert.deepEqual(converted.behavior, native.behavior);
            assert.equal(native.behavior.input, index === 2 ? "Bea" : expected, "the dirty native input keeps its edit");
            assert.equal(native.behavior.text, expected);
            await assertPixelsEqual(react, converted.pixels, native.pixels, "React generic binding pixels differ", live);
            if (index === 0) await Promise.all(pages.map((page) => page.locator("section input").fill("Bea")));
            if (index === 1) await Promise.all(pages.map((page) => page.locator("section output").evaluate((output: HTMLOutputElement) => {
              output.value = "Cy";
              output.dispatchEvent(new Event("input", { bubbles: true }));
            })));
          }
          assert.deepEqual(errors, []);
          assert.deepEqual(warnings.filter((message) => /hydration|mismatch|controlled/i.test(message)), []);
        } finally {
          await Promise.all(pages.map((page) => page.close()));
          await browser.close();
        }
      });
    }
  }
});
