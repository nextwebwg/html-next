import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, it } from "vitest";

import { build } from "esbuild";
import { chromium, firefox, webkit, type BrowserType, type Page } from "playwright";

import { convertComponents } from "../src/index.js";
import { assertPixelsEqual, launchParityBrowser } from "../../html-next/tests/pixel-parity.js";

const enabled = process.env.HTMLNEXT_TARGET_TEST === "1";
const child = `<template component="x-child" status="early" summary="Child."><defs>
  <event name="saved" type="object"><prop name="reason" type="keyword" values="action, programmatic" required></prop></event>
  <event name="quantity" type="number"></event>
  <handler name="fire"><dispatch event="saved" expr:value="{ reason: 'action' }"></dispatch></handler>
  <handler name="fireInvalid"><dispatch event="saved" expr:value="{ reason: 'other' }"></dispatch></handler>
  <handler name="fireNumericString"><dispatch event="quantity" expr:value="'17'"></dispatch></handler>
  <handler name="fireNumericLiteral"><dispatch event="quantity" value="17"></dispatch></handler>
</defs><div><button type="button" on:click="fire">Fire</button><button type="button" on:click="fireInvalid">Invalid</button><button type="button" on:click="fireNumericString">Invalid number</button><button type="button" on:click="fireNumericLiteral">Valid number</button></div></template>`;
const parent = `<template component="x-parent" status="early" summary="Parent."><defs>
  <state type="number" name="hits" value="0"></state>
  <handler name="record"><set name="hits" expr:value="hits + 1"></set></handler>
</defs><section><x-child on:saved.stop="record"></x-child><output $value="hits"></output></section></template>`;

async function snapshot(page: Page, expected: string): Promise<{ readonly hits: string; readonly documentHits: number; readonly pixels: Buffer }> {
  await page.waitForFunction((value) => document.querySelector("output")?.textContent === value, expected);
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  return {
    hits: await page.locator("output").innerText(),
    documentHits: await page.evaluate(() => (window as unknown as { documentHits: number }).documentHits),
    pixels: await page.locator("section").screenshot({ animations: "disabled" }),
  };
}

describe.skipIf(!enabled)("React native custom-event parity", () => {
  let directory = "";
  let liveBundle = "";
  let reactBundle = "";

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-react-events-"));
    await writeFile(join(directory, "child.html"), child);
    await writeFile(join(directory, "parent.html"), `<link rel="component" href="./child.html">${parent}`);
    const outDirectory = join(directory, "out");
    await convertComponents({ mode: "application", target: "react", root: directory, outDirectory, entries: ["*.html"] });
    const reactEntry = join(outDirectory, "entry.tsx");
    await writeFile(reactEntry, `import React from "react";
import { createRoot } from "react-dom/client";
import { XParent } from "./react/application";
createRoot(document.querySelector("main")!).render(<XParent />);`);
    reactBundle = join(outDirectory, "react.js");
    await build({
      entryPoints: [reactEntry], outfile: reactBundle, bundle: true, format: "iife", platform: "browser",
      target: ["es2022"], jsx: "automatic", nodePaths: [fileURLToPath(new URL("../node_modules", import.meta.url))],
    });
    liveBundle = join(directory, "live.js");
    await build({
      entryPoints: [fileURLToPath(new URL("../../html-next/src/live.ts", import.meta.url))],
      outfile: liveBundle, bundle: true, format: "iife", globalName: "HtmlRuntime", platform: "browser", target: ["es2022"],
    });
  });

  afterAll(async () => { if (directory !== "") await rm(directory, { recursive: true, force: true }); });

  for (const [engine, browserType] of [["Chromium", chromium], ["Firefox", firefox], ["WebKit", webkit]] as const satisfies ReadonlyArray<readonly [string, BrowserType]>) {
    it(`${engine} forwards a child root and filters its native CustomEvent`, async () => {
      const browser = await launchParityBrowser(browserType);
      const live = await browser.newPage();
      const react = await browser.newPage();
      const errors: string[] = [];
      try {
        for (const page of [live, react]) page.on("pageerror", (error) => errors.push(error.message));
        await live.setContent(`${child}${parent}<main><x-parent></x-parent></main>`);
        await live.addScriptTag({ path: liveBundle });
        await live.evaluate(() => window.HtmlRuntime.lowerDocument());
        await react.setContent("<main></main>");
        await react.addScriptTag({ path: reactBundle });
        await Promise.all([live, react].map((page) => page.evaluate(() => {
          const result = window as unknown as { documentHits: number; eventErrors: string[]; quantityDetails: unknown[] };
          result.documentHits = 0;
          result.eventErrors = [];
          result.quantityDetails = [];
          window.addEventListener("error", (event) => { result.eventErrors.push(event.message); event.preventDefault(); });
          document.addEventListener("saved", () => { (window as unknown as { documentHits: number }).documentHits += 1; });
          document.addEventListener("quantity", (event) => { result.quantityDetails.push((event as CustomEvent).detail); });
        })));
        for (const expected of ["0", "1", "2"]) {
          const [native, converted] = await Promise.all([snapshot(live, expected), snapshot(react, expected)]);
          assert.deepEqual({ hits: converted.hits, documentHits: converted.documentHits },
            { hits: native.hits, documentHits: native.documentHits });
          await assertPixelsEqual(react, converted.pixels, native.pixels, "React native-event pixels differ", live);
          if (expected !== "2") await Promise.all([live, react].map((page) => page.getByRole("button", { name: "Fire" }).click()));
        }
        await Promise.all([live, react].map((page) => page.getByRole("button", { name: "Invalid", exact: true }).click()));
        await Promise.all([live, react].map((page) => page.waitForFunction(() =>
          (window as unknown as { eventErrors?: string[] }).eventErrors?.length === 1)));
        assert.deepEqual(await react.evaluate(() => (window as unknown as { eventErrors: string[] }).eventErrors),
          await live.evaluate(() => (window as unknown as { eventErrors: string[] }).eventErrors));
        await Promise.all([live, react].map((page) => page.getByRole("button", { name: "Invalid number", exact: true }).click()));
        await Promise.all([live, react].map((page) => page.waitForFunction(() =>
          (window as unknown as { eventErrors?: string[] }).eventErrors?.length === 2)));
        assert.deepEqual((await Promise.all([live, react].map((page) => page.evaluate(() =>
          (window as unknown as { quantityDetails: unknown[] }).quantityDetails)))),
        [[], []]);
        await Promise.all([live, react].map((page) => page.getByRole("button", { name: "Valid number", exact: true }).click()));
        assert.deepEqual((await Promise.all([live, react].map((page) => page.evaluate(() =>
          (window as unknown as { quantityDetails: unknown[] }).quantityDetails)))),
        [[17], [17]]);
        assert.deepEqual(await react.evaluate(() => (window as unknown as { eventErrors: string[] }).eventErrors),
          await live.evaluate(() => (window as unknown as { eventErrors: string[] }).eventErrors));
        assert.deepEqual((await Promise.all([live, react].map((page) => snapshot(page, "2")))).map(({ hits, documentHits }) => ({ hits, documentHits })),
          [{ hits: "2", documentHits: 0 }, { hits: "2", documentHits: 0 }]);
        assert.deepEqual(errors, []);
      } finally {
        await live.close();
        await react.close();
        await browser.close();
      }
    });
  }
});
