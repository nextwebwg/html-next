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
const steps = `<template component="x-steps" status="early" summary="Steps."><defs>
  <state type="number" name="current" value="1"></state>
  <handler name="next"><set name="current" expr:value="current + 1"></set></handler>
</defs><section><button type="button" on:click="next">Next</button><slot></slot></section>
<style>:host { display: block; border: 2px solid rgb(31 65 99); padding: 4px; }</style></template>`;
const step = `<template component="x-step" status="early" summary="Step."><defs>
  <prop name="number" type="number" required>Step number.</prop>
  <context name="current" from="x-steps" as="activeStep"></context>
  <computed name="isActive" from="activeStep = number"></computed>
</defs><p from:data-active="isActive ? 'yes' : 'no'"><slot></slot></p>
<style>:host[data-active="yes"] { color: rgb(20 110 60); }</style></template>`;
const app = `<template component="x-app" status="early" summary="App."><main>
  <x-steps id="outer"><x-step id="outer-one" number="1">Outer one</x-step><x-step id="outer-two" number="2">Outer two</x-step>
    <x-steps id="inner"><x-step id="inner-one" number="1">Inner one</x-step><x-step id="inner-two" number="2">Inner two</x-step></x-steps>
  </x-steps>
</main></template>`;

async function snapshot(page: Page) {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  return {
    behavior: await page.locator("main").evaluate((root) => ({
      outer: ["outer-one", "outer-two"].map((id) => root.querySelector(`#${id}`)?.getAttribute("data-active")),
      inner: ["inner-one", "inner-two"].map((id) => root.querySelector(`#${id}`)?.getAttribute("data-active")),
      color: getComputedStyle(root.querySelector("#outer-one")!).color,
    })),
    pixels: await page.locator("main").screenshot({ animations: "disabled" }),
  };
}

describe.skipIf(!enabled)("React projected context parity", () => {
  let directory = "";
  let liveBundle = "";
  let reactBundle = "";
  let serverMarkup = "";
  let css = "";

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-react-context-"));
    await mkdir(join(directory, "components"));
    await writeFile(join(directory, "components/steps.html"), steps);
    await writeFile(join(directory, "components/step.html"), step);
    await writeFile(join(directory, "components/app.html"), `<link rel="component" href="./steps.html"><link rel="component" href="./step.html">${app}`);
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
      it(`${engine} ${hydrate ? "hydration" : "mount"} keeps nearest-provider context through updates`, async () => {
        const browser = await launchParityBrowser(browserType);
        const live = await browser.newPage();
        const react = await browser.newPage();
        const errors: string[] = [];
        try {
          for (const page of [live, react]) page.on("pageerror", (error) => errors.push(error.message));
          await live.setContent(`${steps}${step}${app}<div id="mount"><x-app></x-app></div>`);
          await live.addScriptTag({ path: liveBundle });
          await live.evaluate(() => window.HtmlRuntime.lowerDocument());
          await react.setContent(`<style>${css}</style><div id="mount">${hydrate ? serverMarkup : ""}</div>`);
          await react.addScriptTag({ path: reactBundle });
          await Promise.all([live, react].map((page) => page.locator("#outer-one").waitFor()));
          for (const expected of [
            { outer: ["yes", "no"], inner: ["yes", "no"] },
            { outer: ["no", "yes"], inner: ["yes", "no"] },
            { outer: ["no", "yes"], inner: ["no", "yes"] },
          ]) {
            await Promise.all([live, react].map((page) => page.waitForFunction((values) =>
              JSON.stringify(["outer-one", "outer-two", "inner-one", "inner-two"].map((id) => document.getElementById(id)?.getAttribute("data-active"))) ===
              JSON.stringify([...values.outer, ...values.inner]), expected)));
            const [native, converted] = await Promise.all([snapshot(live), snapshot(react)]);
            assert.deepEqual(converted.behavior, native.behavior);
            await assertPixelsEqual(react, converted.pixels, native.pixels, "React context pixels differ", live);
            if (expected.outer[0] === "yes") await Promise.all([live, react].map((page) => page.locator("#outer > button").click()));
            else if (expected.inner[0] === "yes") await Promise.all([live, react].map((page) => page.locator("#inner > button").click()));
          }
          assert.deepEqual(errors, []);
        } finally {
          await live.close(); await react.close(); await browser.close();
        }
      });
    }
  }
});
