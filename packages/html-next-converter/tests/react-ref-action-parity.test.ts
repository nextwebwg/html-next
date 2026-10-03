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

const enabled = process.env.HTMLNEXT_TARGET_TEST === "1";
const field = `<template component="x-field" status="early" summary="Focusable input.">
  <input class="field" required aria-label="Name">
</template>`;
const form = `<template component="x-ref-actions" status="early" summary="Reference actions."><defs>
  <state type="number" name="count" value="0"></state>
  <handler name="submit"><validate target="form"></validate><focus ref="field"></focus><set name="count" expr:value="count + 1"></set></handler>
</defs><section><form $ref="form"><x-field $ref="field"></x-field></form>
  <button type="button" on:click="submit">Submit</button><output $value="count"></output></section>
<style>:host { display: block; width: 180px; padding: 4px; font: 16px/24px Arial, sans-serif; }</style></template>`;

async function snapshot(page: Page) {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  return {
    behavior: await page.locator("section").evaluate((root) => {
      const field = root.querySelector<HTMLInputElement>("input")!;
      return {
        count: root.querySelector("output")?.textContent,
        focused: document.activeElement === field,
        missing: field.validity.valueMissing,
        invalidEvents: (window as unknown as { invalidEvents: number }).invalidEvents,
      };
    }),
    pixels: await page.locator("section").screenshot({ animations: "disabled" }),
  };
}

describe.skipIf(!enabled)("React reference action parity", () => {
  let directory = "";
  let liveBundle = "";
  let reactBundle = "";
  let serverMarkup = "";
  let css = "";

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-react-ref-action-"));
    await writeFile(join(directory, "field.html"), field);
    await writeFile(join(directory, "form.html"), `<link rel="component" href="./field.html">${form}`);
    const outDirectory = join(directory, "out");
    const manifest = await convertComponents({ mode: "application", target: "react", root: directory, outDirectory, entries: ["*.html"] });
    css = (await Promise.all(manifest.output.artifacts.filter((artifact) => artifact.kind === "style")
      .map((artifact) => readFile(join(outDirectory, artifact.path), "utf8")))).join("\n");
    const entry = join(outDirectory, "mount.tsx");
    await writeFile(entry, `import React from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import { XRefActions } from "./react/application";
const mount = document.querySelector("main")!;
if (mount.hasChildNodes()) hydrateRoot(mount, <XRefActions />);
else createRoot(mount).render(<XRefActions />);`);
    reactBundle = join(outDirectory, "mount.js");
    await build({
      entryPoints: [entry], outfile: reactBundle, bundle: true, format: "iife", platform: "browser",
      target: ["es2022"], jsx: "automatic", loader: { ".css": "empty" },
      nodePaths: [fileURLToPath(new URL("../node_modules", import.meta.url))],
    });
    const server = await build({
      entryPoints: [join(outDirectory, manifest.output.entry)], bundle: true, write: false,
      platform: "node", format: "cjs", jsx: "automatic", packages: "external", loader: { ".css": "empty" },
    });
    const module = { exports: {} as Record<string, ComponentType<Record<string, unknown>>> };
    new Function("require", "module", "exports", server.outputFiles[0]!.text)(createRequire(import.meta.url), module, module.exports);
    serverMarkup = renderToString(createElement(module.exports.XRefActions!));
    liveBundle = join(directory, "live.js");
    await build({
      entryPoints: [fileURLToPath(new URL("../../html-next/src/live.ts", import.meta.url))],
      outfile: liveBundle, bundle: true, format: "iife", globalName: "HtmlRuntime", platform: "browser", target: ["es2022"],
    });
  });

  afterAll(async () => { if (directory !== "") await rm(directory, { recursive: true, force: true }); });

  for (const [engine, browserType] of [["Chromium", chromium], ["Firefox", firefox], ["WebKit", webkit]] as const satisfies ReadonlyArray<readonly [string, BrowserType]>) {
    for (const hydrate of [false, true]) {
      it(`${engine} ${hydrate ? "hydration" : "mount"} matches ref validation and focus`, async () => {
        const browser = await launchParityBrowser(browserType);
        const live = await browser.newPage();
        const react = await browser.newPage();
        const errors: string[] = [];
        try {
          for (const page of [live, react]) page.on("pageerror", (error) => errors.push(error.message));
          await live.setContent(`${field}${form}<main><x-ref-actions></x-ref-actions></main>`);
          await live.addScriptTag({ path: liveBundle });
          await live.evaluate(() => window.HtmlRuntime.lowerDocument());
          await react.setContent(`<style>${css}</style><main>${hydrate ? serverMarkup : ""}</main>`);
          await react.addScriptTag({ path: reactBundle });
          await Promise.all([live, react].map((page) => page.locator("section input").waitFor()));
          await Promise.all([live, react].map((page) => page.locator("section input").evaluate((input) => {
            (window as unknown as { invalidEvents: number }).invalidEvents = 0;
            input.addEventListener("invalid", () => { (window as unknown as { invalidEvents: number }).invalidEvents++; });
          })));
          for (const [count, missing, invalidEvents] of [["0", true, 0], ["1", true, 1], ["2", false, 1]] as const) {
            await Promise.all([live, react].map((page) => page.waitForFunction((value) => document.querySelector("output")?.textContent === value, count)));
            const [native, converted] = await Promise.all([snapshot(live), snapshot(react)]);
            assert.deepEqual(converted.behavior, native.behavior);
            assert.equal(native.behavior.count, count);
            assert.equal(native.behavior.missing, missing);
            assert.equal(native.behavior.invalidEvents, invalidEvents);
            // reportValidity() shows browser-owned validation UI outside the component surface.
            // Compare the component pixels before validation and after the field becomes valid.
            if (count !== "1") await assertPixelsEqual(react, converted.pixels, native.pixels, "React ref action pixels differ", live);
            if (count === "0") await Promise.all([live, react].map((page) => page.locator("button").click()));
            if (count === "1") {
              await Promise.all([live, react].map((page) => page.locator("input").fill("Ada")));
              await Promise.all([live, react].map((page) => page.locator("button").click()));
            }
          }
          assert.deepEqual(errors, []);
        } finally {
          await live.close(); await react.close(); await browser.close();
        }
      });
    }
  }
});
