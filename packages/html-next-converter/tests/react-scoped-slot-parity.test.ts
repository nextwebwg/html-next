import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
const rows = `<template component="x-rows" status="early" summary="Rows."><defs>
  <state type="list(unknown)" name="rows" value="[{ id: 'a', name: 'Ada' }]"></state>
  <handler name="add"><set name="rows" expr:value="[{ id: 'a', name: 'Ada' }, { id: 'b', name: 'Bea' }]"></set></handler>
</defs><div><button type="button" class="add" on:click="add">Add</button>
  <ul><slot name="row" $each="row of rows" $key="row.id" from:item="row" from:index="loop.index"><li>Missing</li></slot></ul>
</div><style>:host { display: block; background: rgb(238 244 250); padding: 4px; } :slotted(li) { color: rgb(32 48 64); }</style></template>`;
const app = `<template component="x-app" status="early" summary="App."><defs>
  <state type="object" name="item" value="{ name: 'Parent' }"></state>
  <state name="heading" value="Team"></state>
  <handler name="rename"><set name="heading" value="Group"></set></handler>
</defs><main><button type="button" class="rename" on:click="rename">Rename</button><output $value="item.name"></output>
  <x-rows><template slot="row"><li .title="item.name"><b $value="item.name"></b><em $value="heading"></em><small $value="index"></small><input .value="item.name"></li></template></x-rows>
  <x-rows></x-rows>
</main></template>`;

async function snapshot(page: Page) {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  return {
    behavior: await page.locator("main").evaluate((root) => ({
      parent: root.querySelector("output")?.textContent,
      rows: Array.from(root.querySelectorAll("ul"), (list) => Array.from(list.querySelectorAll("li"), (row) => row.textContent?.trim())),
      titles: Array.from(root.querySelectorAll("main > div:first-of-type ul li"), (row) => (row as HTMLElement).title),
      values: Array.from(root.querySelectorAll<HTMLInputElement>("main > div:first-of-type ul li input"), (input) => input.value),
      color: getComputedStyle(root.querySelector("li")!).color,
    })),
    pixels: await page.locator("main").screenshot({ animations: "disabled" }),
  };
}

describe.skipIf(!enabled)("React scoped slot parity", () => {
  let directory = "";
  let liveBundle = "";
  let reactBundle = "";
  let serverMarkup = "";
  let css = "";

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-react-scoped-slot-"));
    await mkdir(join(directory, "components"));
    await writeFile(join(directory, "components/rows.html"), rows);
    await writeFile(join(directory, "components/app.html"), `<link rel="component" href="./rows.html">${app}`);
    const outDirectory = join(directory, "out");
    const manifest = await convertComponents({ mode: "application", target: "react", root: directory, outDirectory, entries: ["components/**"] });
    css = (await Promise.all(manifest.output.artifacts.filter((artifact) => artifact.kind === "style")
      .map((artifact) => readFile(join(outDirectory, artifact.path), "utf8")))).join("\n");
    const entry = join(outDirectory, "mount.tsx");
    await writeFile(entry, `import React from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import { XApp } from "./react/application";
const mount = document.querySelector("#mount")!;
if (mount.hasChildNodes()) hydrateRoot(mount, <XApp />);
else createRoot(mount).render(<XApp />);`);
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
    serverMarkup = renderToString(createElement(module.exports.XApp!));
    liveBundle = join(directory, "live.js");
    await build({
      entryPoints: [fileURLToPath(new URL("../../html-next/src/live.ts", import.meta.url))],
      outfile: liveBundle, bundle: true, format: "iife", globalName: "HtmlRuntime", platform: "browser", target: ["es2022"],
    });
  });

  afterAll(async () => { if (directory !== "") await rm(directory, { recursive: true, force: true }); });

  for (const [engine, browserType] of [["Chromium", chromium], ["Firefox", firefox], ["WebKit", webkit]] as const satisfies ReadonlyArray<readonly [string, BrowserType]>) {
    for (const hydrate of [false, true]) {
      it(`${engine} ${hydrate ? "hydration" : "mount"} matches scoped projection, fallback, and updates`, async () => {
        const browser = await launchParityBrowser(browserType);
        const live = await browser.newPage();
        const react = await browser.newPage();
        const errors: string[] = [];
        try {
          for (const page of [live, react]) page.on("pageerror", (error) => errors.push(error.message));
          await live.setContent(`${rows}${app}<div id="mount"><x-app></x-app></div>`);
          await live.addScriptTag({ path: liveBundle });
          await live.evaluate(() => window.HtmlRuntime.lowerDocument());
          await react.setContent(`<style>${css}</style><div id="mount">${hydrate ? serverMarkup : ""}</div>`);
          await react.addScriptTag({ path: reactBundle });
          await Promise.all([live, react].map((page) => page.locator("main ul").first().waitFor()));
          for (const [count, heading] of [[1, "Team"], [2, "Team"], [2, "Group"]] as const) {
            await Promise.all([live, react].map((page) => page.waitForFunction(([rowsCount, title]) =>
              document.querySelectorAll("main > div:first-of-type ul li").length === rowsCount &&
              document.querySelector("main > div:first-of-type ul li em")?.textContent === title, [count, heading])));
            const [native, converted] = await Promise.all([snapshot(live), snapshot(react)]);
            assert.deepEqual(converted.behavior, native.behavior);
            assert.deepEqual(native.behavior.titles, count === 1 ? ["Ada"] : ["Ada", "Bea"]);
            assert.deepEqual(native.behavior.values, count === 1 ? ["Ada"] : ["Ada", "Bea"]);
            await assertPixelsEqual(react, converted.pixels, native.pixels, "React scoped slot pixels differ", live);
            if (count === 1) await Promise.all([live, react].map((page) => page.locator("button.add").first().click()));
            else if (heading === "Team") await Promise.all([live, react].map((page) => page.locator("button.rename").click()));
          }
          assert.deepEqual(errors, []);
        } finally {
          await live.close(); await react.close(); await browser.close();
        }
      });
    }
  }
});
