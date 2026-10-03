import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, it } from "vitest";

import { build } from "esbuild";
import { chromium, firefox, webkit, type BrowserType, type Page } from "playwright";

import { assertPixelsEqual, launchParityBrowser } from "../../html-next/tests/pixel-parity.js";
import { convertComponents } from "../src/index.js";

const enabled = process.env.HTMLNEXT_TARGET_TEST === "1";
const source = `<template component="x-required-number" status="early" summary="Required numeric prop."><defs>
  <prop name="n" type="number" required>Number.</prop>
</defs><div from:data-n="n"><output from:data-sum="n + 1" $value="n + 1"></output></div></template>`;

async function observe(page: Page): Promise<{ readonly behavior: { readonly value: string | null; readonly sum: string | null; readonly output: string | null; readonly valid: boolean; readonly valueMissing: boolean; readonly badInput: boolean }; readonly pixels: Buffer }> {
  await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
  const root = page.locator("#case");
  const behavior = await root.evaluate((element) => {
      const validity = (element as unknown as Element & { validity: ValidityState }).validity;
      return {
        value: element.getAttribute("data-n"),
        sum: element.querySelector("output")?.getAttribute("data-sum") ?? null,
        output: element.querySelector("output")?.textContent ?? null,
        valid: validity.valid,
        valueMissing: validity.valueMissing,
        badInput: validity.badInput,
      };
    });
  return { behavior, pixels: await page.screenshot({ animations: "disabled" }) };
}

describe.skipIf(!enabled)("public React converter typed-prop diagnostic parity", () => {
  let directory = "";
  let liveBundle = "";
  const bundles = new Map<"application" | "library", string>();

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-react-prop-diagnostic-"));
    await writeFile(join(directory, "number.html"), source);
    liveBundle = join(directory, "live.js");
    await build({ entryPoints: [fileURLToPath(new URL("../../html-next/src/live.ts", import.meta.url))], outfile: liveBundle,
      bundle: true, format: "iife", globalName: "HtmlRuntime", platform: "browser", target: ["es2022"] });
    for (const mode of ["application", "library"] as const) {
      const outDirectory = join(directory, mode);
      const manifest = await convertComponents({ mode, target: "react", entries: ["number.html"], root: directory, outDirectory });
      const entry = join(outDirectory, "entry.tsx");
      const bundle = join(outDirectory, "react.js");
      await writeFile(entry, `import React from "react";
import { createRoot } from "react-dom/client";
import { XRequiredNumber } from "./${manifest.output.entry.replace(/\.ts$/, "")}";
const target = window as any;
target.reactCodes = [];
const record = (error: unknown) => target.reactCodes.push((error as any)?.diagnostic?.code ?? "THROWN");
const root = createRoot(document.querySelector("main")!, { onCaughtError: record, onUncaughtError: record });
target.reactSetCase = (props: Record<string, unknown>) => root.render(<XRequiredNumber id="case" {...props} />);
`);
      await build({ entryPoints: [entry], outfile: bundle, bundle: true, format: "iife", platform: "browser",
        target: ["es2022"], jsx: "automatic", loader: { ".css": "empty" },
        nodePaths: [fileURLToPath(new URL("../node_modules", import.meta.url))] });
      bundles.set(mode, bundle);
    }
  });

  afterAll(async () => { if (directory !== "") await rm(directory, { recursive: true, force: true }); });

  for (const mode of ["application", "library"] as const) {
    for (const [engine, browserType] of [["Chromium", chromium], ["Firefox", firefox], ["WebKit", webkit]] as const satisfies ReadonlyArray<readonly [string, BrowserType]>) {
      it(`${engine} ${mode} retains invalid source values, reports validity, and recovers`, async () => {
        const browser = await launchParityBrowser(browserType);
        const pages: Page[] = [];
        try {
          for (const [attribute, value, validity] of [[undefined, null, "valueMissing"], ["abc", "abc", "badInput"], ["42", 42, "valid"]] as const) {
            const live = await browser.newPage();
            pages.push(live);
            const react = await browser.newPage();
            pages.push(react);
            await live.setContent(`${source}<main><x-required-number id="case"${attribute === undefined ? "" : ` n=${JSON.stringify(attribute)}`}></x-required-number></main>`);
            await live.addScriptTag({ path: liveBundle });
            const liveCode = await live.evaluate(() => {
              try { window.HtmlRuntime.lowerDocument(); return null; }
              catch (error) { return (error as { diagnostic?: { code: string } }).diagnostic?.code ?? "THROWN"; }
            });
            await react.setContent("<main></main>");
            await react.addScriptTag({ path: bundles.get(mode)! });
            await react.evaluate((input) => window.reactSetCase(input === null ? {} : { n: input }), value);
            await react.locator("#case").waitFor({ state: "attached", timeout: 5_000 });
            assert.equal(liveCode, null);
            assert.deepEqual(await react.evaluate(() => window.reactCodes), []);
            const [native, converted] = await Promise.all([observe(live), observe(react)]);
            assert.deepEqual(converted.behavior, native.behavior, "React numeric prop behavior differs");
            assert.equal(native.behavior[validity], true);
            await assertPixelsEqual(react, converted.pixels, native.pixels, "React numeric prop pixels differ", live);
            await Promise.all([live.close(), react.close()]);
            pages.length = 0;
          }
          const live = await browser.newPage();
          pages.push(live);
          const react = await browser.newPage();
          pages.push(react);
          await live.setContent(`${source}<main><x-required-number id="case" n="42"></x-required-number></main>`);
          await live.addScriptTag({ path: liveBundle });
          await live.evaluate(() => window.HtmlRuntime.lowerDocument());
          await react.setContent("<main></main>");
          await react.addScriptTag({ path: bundles.get(mode)! });
          await react.evaluate(() => window.reactSetCase({ n: 42 }));
          await react.locator("#case").waitFor({ state: "attached", timeout: 5_000 });
          const [nativeInitial, convertedInitial] = await Promise.all([observe(live), observe(react)]);
          assert.deepEqual(convertedInitial.behavior, nativeInitial.behavior);
          await assertPixelsEqual(react, convertedInitial.pixels, nativeInitial.pixels, "initial prop pixels differ", live);
          const liveCode = await live.evaluate(() => {
            try { (window.HtmlRuntime as typeof window.HtmlRuntime & { updateComponentProps(element: Element, props: Record<string, unknown>): void })
              .updateComponentProps(document.querySelector("#case")!, { n: "bad" }); return null; }
            catch (error) { return (error as { diagnostic?: { code: string } }).diagnostic?.code ?? "THROWN"; }
          });
          await react.evaluate(() => window.reactSetCase({ n: "bad" }));
          assert.equal(liveCode, null);
          assert.deepEqual(await react.evaluate(() => window.reactCodes), []);
          const [nativeInvalid, convertedInvalid] = await Promise.all([observe(live), observe(react)]);
          assert.deepEqual(convertedInvalid.behavior, nativeInvalid.behavior, "invalid prop update diverged");
          assert.equal(nativeInvalid.behavior.badInput, true);
          await assertPixelsEqual(react, convertedInvalid.pixels, nativeInvalid.pixels, "invalid prop pixels differ", live);
          await live.evaluate(() => (window.HtmlRuntime as typeof window.HtmlRuntime & { updateComponentProps(element: Element, props: Record<string, unknown>): void })
            .updateComponentProps(document.querySelector("#case")!, { n: 43 }));
          await react.evaluate(() => window.reactSetCase({ n: 43 }));
          await react.waitForFunction(() => document.querySelector("#case")?.textContent === "44", undefined, { timeout: 5_000 });
          const [nativeRecovered, convertedRecovered] = await Promise.all([observe(live), observe(react)]);
          assert.equal(nativeRecovered.behavior.output, "44");
          assert.deepEqual(convertedRecovered.behavior, nativeRecovered.behavior);
          await assertPixelsEqual(react, convertedRecovered.pixels, nativeRecovered.pixels, "recovered prop pixels differ", live);
        } finally {
          await Promise.all(pages.map((page) => page.close()));
          await browser.close();
        }
      });
    }
  }
});

declare global {
  interface Window {
    HtmlRuntime: { lowerDocument(): void };
    reactCodes: string[];
    reactSetCase: (props: Record<string, unknown>) => void;
  }
}
