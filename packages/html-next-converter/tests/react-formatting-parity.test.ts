import assert from "node:assert/strict";
import "@formatjs/intl-durationformat/polyfill.js";
import { createRequire } from "node:module";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, it } from "vitest";
import { build } from "esbuild";
import { createElement, type ComponentType } from "react";
import { renderToString } from "react-dom/server";
import { chromium, firefox, webkit } from "playwright";
import ts from "typescript";
import { convertComponents } from "../src/index.js";
import { formattingSource } from "../../html-next/tests/formatting-fixture.js";
import { assertPixelsEqual, launchParityBrowser } from "../../html-next/tests/pixel-parity.js";

const enabled = process.env.HTMLNEXT_TARGET_TEST === "1";

describe.skipIf(!enabled)("React Intl expression parity", () => {
  let directory = "";
  let liveBundle = "";
  const outputs = new Map<string, { bundle: string; markup: string }>();
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-react-formatting-"));
    await symlink(fileURLToPath(new URL("../node_modules", import.meta.url)), join(directory, "node_modules"), "dir");
    await writeFile(join(directory, "formatting.html"), formattingSource);
    liveBundle = join(directory, "live.js");
    await build({ entryPoints: [fileURLToPath(new URL("../../html-next/src/live.ts", import.meta.url))], outfile: liveBundle,
      bundle: true, format: "iife", globalName: "HtmlRuntime", platform: "browser", target: ["es2022"] });
    for (const mode of ["application", "library"] as const) {
      const outDirectory = join(directory, mode);
      const manifest = await convertComponents({ mode, target: "react", root: directory, outDirectory, entries: ["formatting.html"] });
      const diagnostics = ts.getPreEmitDiagnostics(ts.createProgram([join(outDirectory, manifest.components[0]!.artifact)], {
        noEmit: true, strict: true, skipLibCheck: true, allowImportingTsExtensions: true, jsx: ts.JsxEmit.ReactJSX,
        module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, target: ts.ScriptTarget.ES2022,
      })).filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)
        .map((diagnostic) => `${diagnostic.file?.fileName}:${diagnostic.start} TS${diagnostic.code}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")}`);
      assert.deepEqual(diagnostics, [], `${mode} output typechecks`);
      const server = await build({ entryPoints: [join(outDirectory, manifest.output.entry)], bundle: true, write: false,
        platform: "node", format: "cjs", jsx: "automatic", packages: "external", loader: { ".css": "empty" } });
      const module = { exports: {} as Record<string, ComponentType> };
      new Function("require", "module", "exports", server.outputFiles[0]!.text)(createRequire(import.meta.url), module, module.exports);
      const markup = renderToString(createElement(module.exports.XFormatting!));
      await writeFile(join(outDirectory, "entry.tsx"), `import React from 'react';
import { createRoot, hydrateRoot } from 'react-dom/client';
import { XFormatting } from './react/${mode === "application" ? "application" : "index"}';
const mount = document.querySelector('main')!;
if (mount.hasChildNodes()) hydrateRoot(mount, <XFormatting />);
else createRoot(mount).render(<XFormatting />);`);
      const bundle = join(outDirectory, "browser.js");
      await build({ entryPoints: [join(outDirectory, "entry.tsx")], outfile: bundle, bundle: true, format: "iife", platform: "browser",
        target: ["es2022"], jsx: "automatic", loader: { ".css": "empty" }, nodePaths: [fileURLToPath(new URL("../node_modules", import.meta.url))] });
      outputs.set(mode, { bundle, markup });
    }
  });
  afterAll(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });
  for (const [engine, browserType] of [["Chromium", chromium], ["Firefox", firefox], ["WebKit", webkit]] as const) {
    for (const mode of ["application", "library"]) {
      for (const hydrate of [false, true]) {
        it(`${engine} ${mode} ${hydrate ? "SSR hydration" : "mount"} matches native Intl output and reactive locale changes`, async () => {
          const browser = await launchParityBrowser(browserType);
          try {
            const native = await browser.newPage();
            const react = await browser.newPage();
            const errors: string[] = [];
            react.on("pageerror", (error) => errors.push(error.message));
            react.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
            await native.setContent(`${formattingSource}<main><x-formatting></x-formatting></main>`);
            await native.addScriptTag({ path: liveBundle });
            await native.evaluate(() => window.HtmlRuntime.lowerDocument());
            const output = outputs.get(mode)!;
            await react.setContent(`<main>${hydrate ? output.markup : ""}</main>`);
            await react.evaluate(() => Object.assign(window, { originalRoot: document.querySelector("main section") }));
            await react.addScriptTag({ path: output.bundle });
            const read = async (page: typeof react) => page.locator("main section").evaluate((root) => ({
              label: root.getAttribute("aria-label"),
              values: Object.fromEntries(Array.from(root.querySelectorAll("[data-format]"), (element) => [element.getAttribute("data-format"), element.textContent])),
            }));
            for (const changed of [false, true]) {
              await react.waitForFunction((after) => document.querySelector("main section")?.getAttribute("aria-label") === (after ? "25,00 €" : "$12.50"), changed);
              assert.deepEqual(await read(react), await read(native));
              const [nativePixels, reactPixels] = await Promise.all([native, react].map((page) => page.locator("main section").screenshot({ animations: "disabled" })));
              await assertPixelsEqual(react, reactPixels!, nativePixels!, `${engine} ${mode} formatting ${changed}`);
              if (!changed) await Promise.all([native, react].map((page) => page.locator("button").first().click()));
            }
            await Promise.all([native, react].map((page) => page.locator("button").last().click()));
            await react.waitForFunction(() => document.querySelector('[data-format="list"]')?.textContent === "Zed");
            const retained = await read(react);
            assert.deepEqual(retained, await read(native));
            assert.equal(retained.values.currency, "Total: 25,00 € due.");
            assert.equal(retained.values.valueBinding, "25,00 €");
            assert.equal(retained.values.initialInvalid, "Before  after");
            assert.equal(retained.values.initialInvalidBinding, "");
            assert.equal(retained.values.literal, "$amount $HOME $file.name.txt $1.15 {name}");
            assert.equal(retained.values.mixed, "Total: 25,00 € for Zed.");
            assert.equal(retained.values.scoped, "Total: 12,00 € for Zed.");
            assert.equal(retained.values.absent, "");
            if (hydrate) assert.equal(await react.evaluate(() => (window as unknown as { originalRoot: Element }).originalRoot === document.querySelector("main section")), true);
            assert.deepEqual(errors, []);
          } finally { await browser.close(); }
        });
      }
    }
  }
});
