import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, it } from "vitest";

import { build } from "esbuild";
import { createElement, type ComponentType } from "react";
import { renderToString } from "react-dom/server";
import { chromium, firefox, webkit, type BrowserType, type Page } from "playwright";
import ts from "typescript";

import { convertComponents } from "../src/index.js";
import { assertPixelsEqual, launchParityBrowser } from "../../html-next/tests/pixel-parity.js";

const enabled = process.env.HTMLNEXT_TARGET_TEST === "1";
const source = `<template component="x-counter" status="early" summary="Counter."><defs>
  <state type="number" name="count" value="0"></state>
  <state type="length" name="width" value="8.8px"></state>
  <computed name="double" from="count * 2"></computed>
  <computed name="padded" from="width + 2px"></computed>
  <event name="count-change" type="number"></event>
  <handler name="increment"><set name="count" expr:value="count + 1"></set><set name="width" expr:value="'1rem'"></set><dispatch event="count-change" expr:value="count"></dispatch></handler>
</defs><button type="button" class="base" style="border-radius: 0; color: rgb(200, 10, 20) !important" class:active="count > 0" class:invalid="min(width, 5px) = '4px'" class:from-object="{ value: min(width, 5px) }.value = '5px'" style:background-color="count > 0 ? 'rgb(250, 220, 210)' : 'rgb(230, 240, 250)'" style:padding-left="min(width, 5px)" style:margin-left="count >= 0 ? min(width, 5px) : '4px'" .title="min(width, 5px)" on:click.once="increment"
  from:data-rounded="round(width)" from:data-minimum="min(width, 5px)" from:data-maximum="max(2, count + 1)"
  from:data-clamped="clamp(0, count, 10)" from:data-absolute="abs(-3)" from:data-defaulted="default(null, count)"
  from:data-concatenated="concat('count:', count)" from:data-joined="join(['a', 'b'], ',')" from:data-percent="round(25.5%)" from:data-nested="count >= 0 ? min(width, 5px) : 'skip'" from:data-array="['x', min(width, 5px)]" from:data-numeric-array="[min(2, count + 1), 3]" from:data-indexed="['x', min(width, 5px)][1]">
  <span>{$double}</span><output $value="min(width, 5px)"></output><small $value="min(width, 5px)"></small><em $value="['x', min(width, 5px)]"></em><sub>{$padded}</sub><i $if="min(width, 5px) = '4px'">Invalid branch</i>
  <template $match><b $when="min(width, 5px) = '4px'">Invalid match</b><b $else>Valid match</b></template>
</button>
<style>:host { display: inline-block; appearance: none; border: 1px solid rgb(80, 80, 80); padding: 8px; color: rgb(30, 40, 50); } :host-state([count]) { outline: 2px solid rgb(90, 70, 50); }</style>
</template>`;

async function snapshot(page: Page): Promise<{ readonly text: string; readonly padded: string | null; readonly classes: string; readonly background: string; readonly paddingLeft: string; readonly marginLeft: string; readonly invalidBranch: boolean; readonly matchText: string | null; readonly title: string; readonly color: string; readonly colorPriority: string; readonly hostState: string; readonly functions: Record<string, string | null>; readonly events: readonly number[]; readonly pixels: Buffer }> {
  await page.waitForFunction(() => document.querySelector("button span")?.textContent !== undefined);
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  return {
    text: await page.locator("button span").innerText(),
    padded: await page.locator("button sub").textContent(),
    classes: (await page.locator("button").getAttribute("class") ?? "").split(/\s+/).filter(Boolean).sort().join(" "),
    background: await page.locator("button").evaluate((button) => getComputedStyle(button).backgroundColor),
    paddingLeft: await page.locator("button").evaluate((button) => getComputedStyle(button).paddingLeft),
    marginLeft: await page.locator("button").evaluate((button) => getComputedStyle(button).marginLeft),
    invalidBranch: await page.locator("button i").count() > 0,
    matchText: await page.locator("button b").textContent(),
    title: await page.locator("button").evaluate((button) => (button as HTMLButtonElement).title),
    color: await page.locator("button").evaluate((button) => getComputedStyle(button).color),
    colorPriority: await page.locator("button").evaluate((button) => button.style.getPropertyPriority("color")),
    hostState: await page.locator("button").getAttribute("data-x-counter-state") ?? "",
    functions: await page.locator("button").evaluate((button) => Object.fromEntries([
      "rounded", "minimum", "maximum", "clamped", "absolute", "defaulted", "concatenated", "joined", "percent", "nested", "array", "numeric-array", "indexed",
    ].map((name) => [name, button.getAttribute(`data-${name}`)]).concat([
      ["minimumOutput", button.querySelector("output")?.textContent ?? null],
      ["minimumText", button.querySelector("small")?.textContent ?? null],
      ["arrayText", button.querySelector("em")?.textContent ?? null],
    ]))),
    events: await page.evaluate(() => (window as unknown as { parityEvents: number[] }).parityEvents),
    pixels: await page.locator("button").screenshot({ animations: "disabled" }),
  };
}

describe.skipIf(!enabled)("React basic visual and behavior parity", () => {
  let directory = "";
  let liveBundle = "";
  const outputs = new Map<"application" | "library", { reactBundle: string; css: string; serverMarkup: string }>();

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-react-basic-"));
    await symlink(fileURLToPath(new URL("../node_modules", import.meta.url)), join(directory, "node_modules"), "dir");
    await writeFile(join(directory, "counter.html"), source);
    for (const mode of ["application", "library"] as const) {
      const outDirectory = join(directory, `out-${mode}`);
      const manifest = await convertComponents({
        mode, target: "react", root: directory, outDirectory, entries: ["counter.html"],
      });
      const typeOptions: ts.CompilerOptions = {
        noEmit: true, strict: true, skipLibCheck: true, allowImportingTsExtensions: true,
        jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
        // TypeScript 6+ default: a stylesheet import needs a declaration.
        target: ts.ScriptTarget.ES2022, noUncheckedSideEffectImports: true,
      };
      const typeErrors = ts.getPreEmitDiagnostics(ts.createProgram([join(outDirectory, manifest.components[0]!.artifact)], typeOptions))
        .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)
        .map((diagnostic) => {
          const position = diagnostic.start ?? 0;
          const location = diagnostic.file?.getLineAndCharacterOfPosition(position);
          const excerpt = diagnostic.file?.text.slice(Math.max(0, position - 80), position + 120).replace(/\s+/g, " ") ?? "";
          return `${diagnostic.file?.fileName ?? "<unknown>"}:${(location?.line ?? 0) + 1}:${(location?.character ?? 0) + 1} TS${diagnostic.code}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")} ${excerpt}`;
        });
      assert.deepEqual(typeErrors, [], `${mode} React output must typecheck`);
      const style = manifest.output.artifacts.find((artifact) => artifact.kind === "style");
      const css = style === undefined ? "" : await readFile(join(outDirectory, style.path), "utf8");
      const reactEntry = join(outDirectory, "entry.tsx");
      await writeFile(reactEntry, `import React from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import { XCounter } from "./react/${mode === "application" ? "application" : "index"}";
const mount = document.querySelector("main")!;
if (mount.hasChildNodes()) hydrateRoot(mount, <XCounter />);
else createRoot(mount).render(<XCounter />);`);
      const reactBundle = join(outDirectory, "react.js");
      await build({
        entryPoints: [reactEntry], outfile: reactBundle, bundle: true, format: "iife", platform: "browser",
        target: ["es2022"], jsx: "automatic", loader: { ".css": "empty" },
        nodePaths: [fileURLToPath(new URL("../node_modules", import.meta.url))],
      });
      const server = await build({
        entryPoints: [join(outDirectory, manifest.output.entry)], bundle: true, write: false,
        platform: "node", format: "cjs", jsx: "automatic", packages: "external", loader: { ".css": "empty" },
      });
      const module = { exports: {} as Record<string, ComponentType<Record<string, unknown>>> };
      new Function("require", "module", "exports", server.outputFiles[0]!.text)(createRequire(import.meta.url), module, module.exports);
      const serverMarkup = renderToString(createElement(module.exports.XCounter!));
      outputs.set(mode, { reactBundle, css, serverMarkup });
    }
    liveBundle = join(directory, "live.js");
    await build({
      entryPoints: [fileURLToPath(new URL("../../html-next/src/live.ts", import.meta.url))],
      outfile: liveBundle, bundle: true, format: "iife", globalName: "HtmlRuntime", platform: "browser", target: ["es2022"],
    });
  });

  afterAll(async () => { if (directory !== "") await rm(directory, { recursive: true, force: true }); });

  for (const [engine, browserType] of [["Chromium", chromium], ["Firefox", firefox], ["WebKit", webkit]] as const satisfies ReadonlyArray<readonly [string, BrowserType]>) {
    for (const mode of ["application", "library"] as const) {
    for (const hydrate of [false, true]) {
    it(`${engine} ${mode} ${hydrate ? "hydration" : "mount"} matches live runtime before and after a state-changing click`, async () => {
      const { reactBundle, css, serverMarkup } = outputs.get(mode)!;
      const browser = await launchParityBrowser(browserType);
      const live = await browser.newPage();
      const react = await browser.newPage();
      const errors: string[] = [];
      try {
        for (const page of [live, react]) page.on("pageerror", (error) => errors.push(error.message));
        await live.setContent(`${source}<main><x-counter></x-counter></main>`);
        await live.addScriptTag({ path: liveBundle });
        await live.evaluate(() => window.HtmlRuntime.lowerDocument());
        await react.setContent(`<style>${css}</style><main>${hydrate ? serverMarkup : ""}</main>`);
        await react.addScriptTag({ path: reactBundle });
        try { await Promise.all([live, react].map((page) => page.locator("button").waitFor({ timeout: 5_000 }))); }
        catch (error) { throw new Error(`Button did not render: ${JSON.stringify(errors)}`, { cause: error }); }
        await Promise.all([live, react].map((page) => page.evaluate(() => {
          const data = window as unknown as { parityEvents: number[] };
          data.parityEvents = [];
          document.querySelector("button")!.addEventListener("count-change", (event) => {
            data.parityEvents.push((event as CustomEvent<number>).detail);
          });
        })));
        for (const expected of ["0", "2"]) {
          try {
            await Promise.all([live, react].map((page) => page.waitForFunction((value) =>
              document.querySelector("button span")?.textContent === value, expected, { timeout: 5_000 })));
          } catch (error) {
            const states = await Promise.all([live, react].map((page) => page.evaluate(() => ({
              text: document.querySelector("button span")?.textContent,
              title: (document.querySelector("button") as HTMLButtonElement | null)?.title,
            }))));
            throw new Error(`Expected ${expected}: ${JSON.stringify({ states, errors })}`, { cause: error });
          }
          const [native, converted] = await Promise.all([snapshot(live), snapshot(react)]);
          assert.equal(converted.text, native.text);
          assert.equal(native.padded, "10.8px");
          assert.equal(converted.padded, native.padded);
          assert.equal(converted.classes, native.classes);
          assert.ok(native.classes.split(" ").includes("from-object"));
          assert.equal(converted.background, native.background);
          assert.equal(native.paddingLeft, "5px");
          assert.equal(converted.paddingLeft, native.paddingLeft);
          assert.equal(native.marginLeft, "5px");
          assert.equal(converted.marginLeft, native.marginLeft);
          assert.equal(native.invalidBranch, false);
          assert.equal(converted.invalidBranch, native.invalidBranch);
          assert.equal(native.matchText, "Valid match");
          assert.equal(converted.matchText, native.matchText);
          assert.equal(native.title, "5px");
          assert.equal(converted.title, native.title);
          assert.equal(converted.color, native.color);
          assert.equal(converted.colorPriority, native.colorPriority);
          assert.equal(converted.hostState, native.hostState);
          assert.deepEqual(native.functions, {
            rounded: expected === "0" ? "9px" : "1rem",
            minimum: "5px",
            minimumOutput: "5px",
            minimumText: "5px",
            maximum: "2",
            clamped: expected === "0" ? "0" : "1",
            absolute: "3",
            defaulted: expected === "0" ? "0" : "1",
            concatenated: `count:${expected === "0" ? "0" : "1"}`,
            joined: "a,b",
            percent: "26%",
            nested: "5px",
            array: "x 5px",
            arrayText: "x 5px",
            "numeric-array": expected === "0" ? "1 3" : "2 3",
            indexed: "5px",
          });
          assert.deepEqual(converted.functions, native.functions);
          assert.deepEqual(converted.events, native.events);
          await assertPixelsEqual(react, converted.pixels, native.pixels, "React counter pixels differ", live);
          if (expected === "0") await Promise.all([live, react].map((page) => page.locator("button").click()));
        }
        await Promise.all([live, react].map((page) => page.locator("button").click()));
        const [nativeOnce, convertedOnce] = await Promise.all([snapshot(live), snapshot(react)]);
        assert.equal(convertedOnce.text, nativeOnce.text, "once listener fired again after re-render");
        assert.deepEqual(errors, []);
      } finally {
        await live.close();
        await react.close();
        await browser.close();
      }
    });
    }
    }
  }
});
