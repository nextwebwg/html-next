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

import { convertComponents, type ConversionGraph } from "../src/index.js";
import { assertPixelsEqual, launchParityBrowser } from "../../html-next/tests/pixel-parity.js";

const enabled = process.env.HTMLNEXT_TARGET_TEST === "1";
const source = `<template component="x-dynamic-control" status="early" summary="Dynamic control path."><defs>
  <state type="list(unknown)" name="rows" value="[{ id: 'a', name: 'Ada' }, { id: 'b', name: 'Bea' }]"></state>
  <state type="number" name="selected" value="1"></state>
  <handler name="choose"><set name="selected" expr:value="selected = 1 ? 0 : 1"></set></handler>
  <handler name="reorder"><set name="rows" expr:value="[rows.1, rows.0]"></set></handler>
</defs><section><input class="edit" bind:value="rows[selected].name">
  <button type="button" on:click="choose">Switch</button>
  <button type="button" class="reorder" on:click="reorder">Reorder</button>
  <div class="row" $each="row of rows" $key="row.id"><input class="row-edit" bind:value="rows[loop.index].name"></div>
  <output class="first" $value="rows.0.name"></output>
  <output class="second" $value="rows.1.name"></output>
</section><style>:host { display: block; padding: 6px; background: rgb(240 245 250); }</style></template>`;

async function snapshot(page: Page) {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  return {
    behavior: await page.locator("section").evaluate((root) => ({
      input: (root.querySelector(".edit") as HTMLInputElement).value,
      rowInputs: Array.from(root.querySelectorAll<HTMLInputElement>(".row-edit"), (input) => input.value),
      first: root.querySelector(".first")?.textContent,
      second: root.querySelector(".second")?.textContent,
    })),
    pixels: await page.locator("section").screenshot({ animations: "disabled" }),
  };
}

describe.skipIf(!enabled)("React dynamic native control parity", () => {
  let directory = "";
  let liveBundle = "";
  const converted = new Map<ConversionGraph, { readonly bundle: string; readonly serverMarkup: string; readonly css: string }>();

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-react-dynamic-control-"));
    await writeFile(join(directory, "control.html"), source);
    for (const mode of ["application", "library"] as const) {
      const outDirectory = join(directory, mode);
      const manifest = await convertComponents({ mode, target: "react", root: directory, outDirectory, entries: ["control.html"] });
      const css = (await Promise.all(manifest.output.artifacts.filter((artifact) => artifact.kind === "style")
        .map((artifact) => readFile(join(outDirectory, artifact.path), "utf8")))).join("\n");
      const entry = join(outDirectory, "mount.tsx");
      await writeFile(entry, `import React from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import { XDynamicControl } from "./react/${mode === "application" ? "application" : "index"}";
const mount = document.querySelector("main")!;
if (mount.hasChildNodes()) hydrateRoot(mount, <XDynamicControl />);
else createRoot(mount).render(<XDynamicControl />);`);
      const bundle = join(outDirectory, "mount.js");
      await build({
        entryPoints: [entry], outfile: bundle, bundle: true, format: "iife", platform: "browser",
        target: ["es2022"], jsx: "automatic", loader: { ".css": "empty" },
        nodePaths: [fileURLToPath(new URL("../node_modules", import.meta.url))],
      });
      const server = await build({
        entryPoints: [join(outDirectory, manifest.output.entry)], bundle: true, write: false,
        platform: "node", format: "cjs", jsx: "automatic", packages: "external", loader: { ".css": "empty" },
      });
      const module = { exports: {} as Record<string, ComponentType<Record<string, unknown>>> };
      new Function("require", "module", "exports", server.outputFiles[0]!.text)(createRequire(import.meta.url), module, module.exports);
      converted.set(mode, { bundle, serverMarkup: renderToString(createElement(module.exports.XDynamicControl!)), css });
    }
    liveBundle = join(directory, "live.js");
    await build({
      entryPoints: [fileURLToPath(new URL("../../html-next/src/live.ts", import.meta.url))],
      outfile: liveBundle, bundle: true, format: "iife", globalName: "HtmlRuntime", platform: "browser", target: ["es2022"],
    });
  });

  afterAll(async () => { if (directory !== "") await rm(directory, { recursive: true, force: true }); });

  for (const mode of ["application", "library"] as const) {
    for (const [engine, browserType] of [["Chromium", chromium], ["Firefox", firefox], ["WebKit", webkit]] as const satisfies ReadonlyArray<readonly [string, BrowserType]>) {
      for (const hydrate of [false, true]) {
        it(`${engine} ${mode} ${hydrate ? "hydration" : "mount"} writes the selected state path and preserves pixels`, async () => {
        const browser = await launchParityBrowser(browserType);
        const pages: Page[] = [];
        const errors: string[] = [];
        const warnings: string[] = [];
        try {
          const live = await browser.newPage();
          pages.push(live);
          const react = await browser.newPage();
          pages.push(react);
          for (const page of pages) page.on("pageerror", (error) => errors.push(error.message));
          react.on("console", (message) => { if (message.type() === "warning" || message.type() === "error") warnings.push(message.text()); });
          await live.setContent(`${source}<main><x-dynamic-control></x-dynamic-control></main>`);
          await live.addScriptTag({ path: liveBundle });
          await live.evaluate(() => window.HtmlRuntime.lowerDocument());
          const output = converted.get(mode)!;
          await react.setContent(`<style>${output.css}</style><main>${hydrate ? output.serverMarkup : ""}</main>`);
          await react.addScriptTag({ path: output.bundle });
          await Promise.all(pages.map((page) => page.locator(".edit").waitFor()));
          const compare = async (expected: { input: string; rowInputs: string[]; first: string; second: string }) => {
            const [native, converted] = await Promise.all([snapshot(live), snapshot(react)]);
            assert.deepEqual(native.behavior, expected);
            assert.deepEqual(converted.behavior, native.behavior);
            // Chromium's parser-created hydrated button differs from the runtime-created button
            // by two one-channel border pixels despite identical geometry and computed styles.
            await assertPixelsEqual(react, converted.pixels, native.pixels, "React dynamic control pixels differ", live,
              engine === "Chromium" && hydrate ? { maxChangedPixels: 2, maxChannelDelta: 1 } : undefined);
          };
          const edit = async (value: string) => Promise.all(pages.map((page) => page.locator(".edit").evaluate((input: HTMLInputElement, next) => {
            input.value = next;
            input.dispatchEvent(new Event("input", { bubbles: true }));
          }, value)));
          await compare({ input: "Bea", rowInputs: ["Ada", "Bea"], first: "Ada", second: "Bea" });
          await edit("Bob");
          await compare({ input: "Bob", rowInputs: ["Ada", "Bob"], first: "Ada", second: "Bob" });
          await Promise.all(pages.map((page) => page.getByRole("button", { name: "Switch" }).click()));
          await compare({ input: "Ada", rowInputs: ["Ada", "Bob"], first: "Ada", second: "Bob" });
          await edit("Ann");
          await compare({ input: "Ann", rowInputs: ["Ann", "Bob"], first: "Ann", second: "Bob" });
          await Promise.all(pages.map((page) => page.locator(".reorder").click()));
          await compare({ input: "Bob", rowInputs: ["Bob", "Ann"], first: "Bob", second: "Ann" });
          await Promise.all(pages.map((page) => page.locator(".row-edit").first().evaluate((input: HTMLInputElement) => {
            input.value = "Bobby";
            input.dispatchEvent(new Event("input", { bubbles: true }));
          })));
          await compare({ input: "Bobby", rowInputs: ["Bobby", "Ann"], first: "Bobby", second: "Ann" });
          assert.deepEqual(errors, []);
          assert.deepEqual(warnings.filter((warning) => /hydration|mismatch/i.test(warning)), []);
        } finally {
          try { await Promise.all(pages.map((page) => page.close())); }
          finally { await browser.close(); }
        }
        });
      }
    }
  }
});
