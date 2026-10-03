import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, it } from "vitest";

import { build } from "esbuild";
import { createElement, type ComponentType } from "react";
import { renderToString } from "react-dom/server";
import { chromium, firefox, webkit, type BrowserType, type Page } from "playwright";
import ts from "typescript";

import { convertComponents, type ConversionGraph } from "../src/index.js";
import { assertPixelsEqual, launchParityBrowser } from "../../html-next/tests/pixel-parity.js";

const enabled = process.env.HTMLNEXT_TARGET_TEST === "1";
const source = `<template component="x-property" status="early" summary="Native property parity."><defs>
  <state type="boolean" name="locked" value="true"></state>
  <state name="destination" value="https://example.test/a"></state>
  <state type="number" name="position" value="15"></state>
  <state name="message" value="Before"></state>
  <state type="number" name="pulse" value="0"></state>
  <state type="number" name="hits" value="0"></state>
  <state type="list(unknown)" name="items" value="[{ id: 'a', locked: true, label: 'A' }, { id: 'b', locked: false, label: 'B' }]"></state>
  <state type="object({ label: string })" name="firstItem" value="{ label: 'A' }"></state>
  <handler name="rerender"><set name="pulse" expr:value="pulse + 1"></set></handler>
  <handler name="record"><set name="hits" expr:value="hits + 1"></set></handler>
  <handler name="advance"><set name="locked" expr:value="false"></set>
    <set name="destination" expr:value="'https://example.test/b'"></set>
    <set name="position" expr:value="30"></set><set name="message" expr:value="'After'"></set>
    <set name="items" expr:value="[{ id: 'a', locked: false, label: 'AA' }, { id: 'b', locked: true, label: 'BB' }]"></set>
    <set name="firstItem" expr:value="{ label: 'AA' }"></set></handler>
</defs><section><button class="submit" type="submit" .disabled="locked" .formAction="destination">Go</button>
  <div class="scroll" .scrollTop="position"><p>One</p><p>Two</p><p>Three</p></div>
  <span class="message" .textContent="message"></span>
  <div class="row" $each="item of items" $key="item.id"><button class="row-button" type="button" .disabled="item.locked" on:click.once="record" $value="item.label"></button>
    <input class="row-input" .value="item.label"></div>
  <span class="alias" $with="firstItem as first" .title="first.label" $value="first.label"></span>
  <template $match="firstItem as match"><span class="matched" $when="match.label = 'A'" .title="match.label" $value="match.label"></span>
    <span class="matched" $else .title="match.label" $value="match.label"></span></template>
  <button class="pulse" type="button" on:click="rerender">Pulse</button><output class="pulse-value" $value="pulse"></output><output class="hits" $value="hits"></output>
  <button class="advance" type="button" on:click="advance">Advance</button></section>
<style>:host { display: block; width: 180px; font: 16px/24px Arial, sans-serif; }
  .scroll { height: 24px; overflow: auto; } .scroll p { margin: 0; height: 24px; }</style></template>`;

async function behaviorSnapshot(page: Page) {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  return page.locator("section").evaluate((root) => {
      const submit = root.querySelector<HTMLButtonElement>(".submit")!;
      return {
        disabled: submit.disabled,
        formAction: submit.formAction,
        formActionAttribute: submit.getAttribute("formaction"),
        scrollTop: root.querySelector<HTMLElement>(".scroll")!.scrollTop,
        message: root.querySelector(".message")!.textContent,
        pulse: root.querySelector(".pulse-value")!.textContent,
        hits: root.querySelector(".hits")!.textContent,
        alias: [root.querySelector<HTMLElement>(".alias")!.title, root.querySelector(".alias")!.textContent],
        matched: [root.querySelector<HTMLElement>(".matched")!.title, root.querySelector(".matched")!.textContent],
        rows: Array.from(root.querySelectorAll(".row"), (row) => ({
          disabled: row.querySelector<HTMLButtonElement>(".row-button")!.disabled,
          label: row.querySelector(".row-button")!.textContent,
          input: row.querySelector<HTMLInputElement>(".row-input")!.value,
        })),
      };
    });
}

async function snapshot(page: Page) {
  return {
    behavior: await behaviorSnapshot(page),
    pixels: await page.locator("section").screenshot({ animations: "disabled" }),
  };
}

describe.skipIf(!enabled)("React native property parity", () => {
  let directory = "";
  let liveBundle = "";
  const outputs = new Map<ConversionGraph, { readonly bundle: string; readonly markup: string; readonly css: string }>();

  beforeAll(async () => {
    const contextDirectory = fileURLToPath(new URL("../.context/", import.meta.url));
    await mkdir(contextDirectory, { recursive: true });
    directory = await mkdtemp(join(contextDirectory, "react-property-"));
    await writeFile(join(directory, "property.html"), source);
    for (const mode of ["application", "library"] as const) {
      const outDirectory = join(directory, mode);
      const manifest = await convertComponents({ mode, target: "react", root: directory, outDirectory, entries: ["property.html"] });
      const program = ts.createProgram([join(outDirectory, manifest.output.entry)], {
        noEmit: true, strict: true, skipLibCheck: true, allowImportingTsExtensions: true, jsx: ts.JsxEmit.ReactJSX,
        module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, target: ts.ScriptTarget.ES2022,
      });
      assert.deepEqual(ts.getPreEmitDiagnostics(program).filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)
        .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")), [], `${mode} generated TypeScript does not compile`);
      const css = (await Promise.all(manifest.output.artifacts.filter((artifact) => artifact.kind === "style")
        .map((artifact) => readFile(join(outDirectory, artifact.path), "utf8")))).join("\n");
      const entry = join(outDirectory, "mount.tsx");
      await writeFile(entry, `import React from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import { XProperty } from "./react/${mode === "application" ? "application" : "index"}";
const mount = document.querySelector("main")!;
if (mount.hasChildNodes()) hydrateRoot(mount, <XProperty />);
else createRoot(mount).render(<XProperty />);`);
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
      outputs.set(mode, { bundle, markup: renderToString(createElement(module.exports.XProperty!)), css });
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
        it(`${engine} ${mode} ${hydrate ? "hydration" : "mount"} matches native properties before and after updates`, async () => {
        const browser = await launchParityBrowser(browserType);
        const live = await browser.newPage();
        const react = await browser.newPage();
        const errors: string[] = [];
        try {
          const output = outputs.get(mode)!;
          for (const page of [live, react]) page.on("pageerror", (error) => errors.push(error.message));
          await Promise.all([
            (async () => {
              await live.setContent(`${source}<main><x-property></x-property></main>`);
              await live.addScriptTag({ path: liveBundle });
              await live.evaluate(() => window.HtmlRuntime.lowerDocument());
            })(),
            (async () => {
              await react.setContent(`<style>${output.css}</style><main>${hydrate ? output.markup : ""}</main>`);
              await react.addScriptTag({ path: output.bundle });
            })(),
          ]);
          await Promise.all([live, react].map((page) => page.locator("section .advance").waitFor()));
          for (const expected of ["Before", "After"]) {
            await Promise.all([live, react].map((page) => page.waitForFunction((value) =>
              document.querySelector("section .message")?.textContent === value, expected)));
            const [native, converted] = await Promise.all([snapshot(live), snapshot(react)]);
            assert.deepEqual(converted.behavior, native.behavior);
            assert.deepEqual(native.behavior.rows, expected === "Before"
              ? [{ disabled: true, label: "A", input: "A" }, { disabled: false, label: "B", input: "B" }]
              : [{ disabled: false, label: "AA", input: "AA" }, { disabled: true, label: "BB", input: "BB" }]);
            assert.deepEqual(native.behavior.alias, expected === "Before" ? ["A", "A"] : ["AA", "AA"]);
            assert.deepEqual(native.behavior.matched, expected === "Before" ? ["A", "A"] : ["AA", "AA"]);
            await assertPixelsEqual(react, converted.pixels, native.pixels, "React native property pixels differ", live);
            if (expected === "Before") {
              for (const expectedHits of ["1", "1"]) {
                await Promise.all([live, react].map((page) => page.locator(".row-button").last().click()));
                const [nativeClick, convertedClick] = await Promise.all([behaviorSnapshot(live), behaviorSnapshot(react)]);
                assert.equal(nativeClick.hits, expectedHits);
                assert.deepEqual(convertedClick, nativeClick, "a scoped once listener must not rearm on render");
              }
              for (const page of [live, react]) await page.locator(".row-input").first().evaluate((input: HTMLInputElement) => { input.value = "Edited"; });
              await Promise.all([live, react].map((page) => page.locator("section .pulse").click()));
              const [nativePulse, convertedPulse] = await Promise.all([snapshot(live), snapshot(react)]);
              assert.deepEqual(convertedPulse.behavior, nativePulse.behavior, "a row's native edit should survive an unrelated render");
              assert.equal(nativePulse.behavior.rows[0]?.input, "Edited");
              await assertPixelsEqual(react, convertedPulse.pixels, nativePulse.pixels, "React scoped property pixels differ after unrelated render", live);
              await Promise.all([live, react].map((page) => page.locator("section .advance").click()));
            }
          }
          assert.deepEqual(errors, []);
        } finally {
          await live.close(); await react.close(); await browser.close();
        }
      });
      }
    }
  }
});
