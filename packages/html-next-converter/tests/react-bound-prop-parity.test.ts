import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, it } from "vitest";

import { build } from "esbuild";
import { chromium, firefox, webkit, type BrowserType, type Page } from "playwright";

import { assertPixelsEqual, launchParityBrowser } from "../../html-next/tests/pixel-parity.js";
import { convertComponents } from "../src/index.js";

const enabled = process.env.HTMLNEXT_TARGET_TEST === "1";
const reading = `<template component="x-reading" status="early" summary="Typed reading."><defs>
  <prop name="amount" type="number" default="5" max="6">Amount.</prop>
</defs><output from:data-amount="amount" $value="amount"></output></template>`;
const owner = `<template component="x-reading-owner" status="early" summary="Reading owner."><defs>
  <prop name="incoming" type="number">Source amount.</prop>
</defs><section class:large="incoming > 3" style:color="incoming > 3 ? 'red' : 'blue'"><x-reading from:amount="incoming"></x-reading><span from:data-direct="incoming"><template $value="incoming"></template></span><em $html="incoming"></em><aside .textContent="incoming"></aside><input type="text" .value="incoming"><div .title="incoming"></div></section></template>`;
const modeReading = `<template component="x-mode-reading" status="early" summary="Selected reading."><defs>
  <prop name="mode" type="keyword" values="text, number" default="number">Reading mode.</prop>
  <prop name="value">Value.<type from="mode"><option value="text" type="string"></option><option value="number" type="number"></option></type></prop>
</defs><output from:data-mode="mode" from:data-value="value">Reading</output></template>`;
const modeOwner = `<template component="x-mode-owner" status="early" summary="Selected reading owner."><defs>
  <prop name="mode" type="keyword" values="text, number" default="number">Reading mode.</prop>
  <prop name="incoming">Incoming value.<type from="mode"><option value="text" type="string"></option><option value="number" type="number"></option></type></prop>
</defs><section><x-mode-reading from:value="incoming" from:mode="mode"></x-mode-reading><x-reading from:amount="incoming"></x-reading></section></template>`;
import { stateSelectedReading as stateReading } from "./fixtures/state-selected-reading.js";

async function observe(page: Page) {
  await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
  const region = await page.locator("section").boundingBox();
  assert.ok(region);
  return {
    behavior: await page.locator("section").evaluate((outer) => {
      const inner = outer.querySelector("output")!;
      const validity = (element: Element) => (element as Element & { validity: ValidityState }).validity;
      return {
        source: outer.getAttribute("data-incoming"),
        outerBadInput: validity(outer).badInput,
        amount: inner.getAttribute("data-amount"),
        text: inner.textContent,
        innerValid: validity(inner).valid,
        direct: outer.querySelector("span")!.getAttribute("data-direct"),
        directText: outer.querySelector("span")!.textContent,
        html: outer.querySelector("em")!.innerHTML,
        propertyText: outer.querySelector("aside")!.textContent,
        controlValue: outer.querySelector("input")!.value,
        propertyTitle: outer.querySelector("div")!.title,
        large: outer.classList.contains("large"),
        color: (outer as HTMLElement).style.color,
      };
    }),
    pixels: await page.screenshot({ animations: "disabled", clip: region }),
  };
}

describe.skipIf(!enabled)("React typed child-prop binding parity", () => {
  let directory = "";
  let liveBundle = "";
  const bundles = new Map<"application" | "library", { readonly browser: string; readonly css: string }>();

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-react-bound-prop-"));
    await mkdir(join(directory, "components"));
    await writeFile(join(directory, "components/reading.html"), reading);
    await writeFile(join(directory, "components/owner.html"), `<link rel="component" href="./reading.html">${owner}`);
    await writeFile(join(directory, "components/mode-reading.html"), modeReading);
    await writeFile(join(directory, "components/mode-owner.html"), `<link rel="component" href="./mode-reading.html"><link rel="component" href="./reading.html">${modeOwner}`);
    await writeFile(join(directory, "components/state-reading.html"), stateReading);
    liveBundle = join(directory, "live.js");
    await build({ entryPoints: [fileURLToPath(new URL("../../html-next/src/live.ts", import.meta.url))], outfile: liveBundle,
      bundle: true, format: "iife", globalName: "HtmlRuntime", platform: "browser", target: ["es2022"] });
    for (const mode of ["application", "library"] as const) {
      const outDirectory = join(directory, mode);
      const manifest = await convertComponents({ mode, target: "react", entries: ["components/**"], root: directory, outDirectory });
      const css = (await Promise.all(manifest.output.artifacts.filter((artifact) => artifact.kind === "style")
        .map((artifact) => readFile(join(outDirectory, artifact.path), "utf8")))).join("\n");
      const entry = join(outDirectory, "mount.tsx");
      await writeFile(entry, `import React from "react";
import { createRoot } from "react-dom/client";
import { XReadingOwner, XModeOwner, XStateReading } from "./${manifest.output.entry.replace(/\.ts$/, "")}";
const root = createRoot(document.querySelector("main")!);
(window as any).setIncoming = (incoming: unknown) => root.render(<XReadingOwner incoming={incoming as number} />);
(window as any).setModeCase = (mode: string, incoming: unknown) => root.render(<XModeOwner mode={mode as "text" | "number"} incoming={incoming as string | number} />);
(window as any).setStateReading = (value: unknown) => root.render(<XStateReading value={value as string | number} />);`);
      const browser = join(outDirectory, "react.js");
      await build({ entryPoints: [entry], outfile: browser, bundle: true, format: "iife", platform: "browser",
        target: ["es2022"], jsx: "automatic", loader: { ".css": "empty" },
        nodePaths: [fileURLToPath(new URL("../node_modules", import.meta.url))] });
      bundles.set(mode, { browser, css });
    }
  });

  afterAll(async () => { if (directory !== "") await rm(directory, { recursive: true, force: true }); });

  for (const mode of ["application", "library"] as const) {
    for (const [engine, browserType] of [["Chromium", chromium], ["Firefox", firefox], ["WebKit", webkit]] as const satisfies ReadonlyArray<readonly [string, BrowserType]>) {
      it(`${engine} ${mode} preserves the child destination across invalid parent values`, async () => {
        const browser = await launchParityBrowser(browserType);
        const live = await browser.newPage();
        const react = await browser.newPage();
        const errors: string[] = [];
        try {
          for (const page of [live, react]) page.on("pageerror", (error) => errors.push(error.message));
          await live.setContent(`${reading}${owner}<main><x-reading-owner incoming="2"></x-reading-owner></main>`);
          await live.addScriptTag({ path: liveBundle });
          await live.evaluate(() => window.HtmlRuntime.lowerDocument());
          const output = bundles.get(mode)!;
          await react.setContent(`<style>${output.css}</style><main></main>`);
          await react.addScriptTag({ path: output.browser });
          for (const [incoming, expected] of [
            [2, { source: "2", outerBadInput: false, amount: "2", text: "2", innerValid: true, direct: "2", directText: "2", html: "2", propertyText: "2", controlValue: "2", propertyTitle: "2", large: false, color: "blue" }],
            ["oops", { source: "oops", outerBadInput: true, amount: "2", text: "2", innerValid: true, direct: "2", directText: "2", html: "2", propertyText: "2", controlValue: "2", propertyTitle: "2", large: false, color: "blue" }],
            [7, { source: "7", outerBadInput: false, amount: "7", text: "7", innerValid: false, direct: "7", directText: "7", html: "7", propertyText: "7", controlValue: "7", propertyTitle: "7", large: true, color: "red" }],
            ["oops", { source: "oops", outerBadInput: true, amount: "7", text: "7", innerValid: false, direct: "7", directText: "7", html: "7", propertyText: "7", controlValue: "7", propertyTitle: "7", large: true, color: "red" }],
          ] as const) {
            await live.evaluate((value) => (window.HtmlRuntime as typeof window.HtmlRuntime & {
              updateComponentProps(element: Element, props: Record<string, unknown>): void;
            }).updateComponentProps(document.querySelector("section")!, { incoming: value }), incoming);
            await react.evaluate((value) => window.setIncoming(value), incoming);
            await react.locator("section").waitFor({ state: "attached" });
            const native = await observe(live);
            const converted = await observe(react);
            assert.deepEqual(native.behavior, expected);
            assert.deepEqual(converted.behavior, native.behavior);
            await assertPixelsEqual(react, converted.pixels, native.pixels, "React bound prop pixels differ", live);
          }
          const liveInitial = await browser.newPage();
          const reactInitial = await browser.newPage();
          try {
            await liveInitial.setContent(`${reading}${owner}<main><x-reading-owner incoming="oops"></x-reading-owner></main>`);
            await liveInitial.addScriptTag({ path: liveBundle });
            await liveInitial.evaluate(() => window.HtmlRuntime.lowerDocument());
            await reactInitial.setContent(`<style>${output.css}</style><main></main>`);
            await reactInitial.addScriptTag({ path: output.browser });
            await reactInitial.evaluate(() => window.setIncoming("oops"));
            await reactInitial.locator("section").waitFor({ state: "attached" });
            const nativeInitial = await observe(liveInitial);
            const convertedInitial = await observe(reactInitial);
            assert.deepEqual(nativeInitial.behavior, { source: null, outerBadInput: true, amount: "5", text: "5", innerValid: true, direct: null, directText: "", html: "", propertyText: "", controlValue: "", propertyTitle: "null", large: false, color: "blue" });
            assert.deepEqual(convertedInitial.behavior, nativeInitial.behavior);
            await assertPixelsEqual(reactInitial, convertedInitial.pixels, nativeInitial.pixels, "React initial invalid bound prop pixels differ", liveInitial);
          } finally {
            await liveInitial.close(); await reactInitial.close();
          }
          assert.deepEqual(errors, []);
        } finally {
          await live.close(); await react.close(); await browser.close();
        }
      });
      it(`${engine} ${mode} checks a bound prop against its selected type`, async () => {
        const browser = await launchParityBrowser(browserType);
        const live = await browser.newPage();
        const react = await browser.newPage();
        try {
          await live.setContent(`${reading}${modeReading}${modeOwner}<main><x-mode-owner mode="number" incoming="2"></x-mode-owner></main>`);
          await live.addScriptTag({ path: liveBundle });
          await live.evaluate(() => window.HtmlRuntime.lowerDocument());
          const output = bundles.get(mode)!;
          await react.setContent(`<style>${output.css}</style><main></main>`);
          await react.addScriptTag({ path: output.browser });
          for (const [selected, incoming] of [["number", 2], ["number", "oops"], ["text", "hello"], ["text", 42]] as const) {
            await live.evaluate(({ selected: choice, incoming: value }) => (window.HtmlRuntime as typeof window.HtmlRuntime & {
              updateComponentProps(element: Element, props: Record<string, unknown>): void;
            }).updateComponentProps(document.querySelector("section")!, { mode: choice, incoming: value }), { selected, incoming });
            await react.evaluate(({ selected: choice, incoming: value }) => window.setModeCase(choice, value), { selected, incoming });
            await react.locator("section").waitFor({ state: "attached" });
            await Promise.all([live, react].map((page) => page.evaluate(() => new Promise<void>((done) =>
              requestAnimationFrame(() => requestAnimationFrame(() => done()))))));
            const read = (page: Page) => page.locator("section").evaluate((element) => {
              const [selectedOutput, numericOutput] = element.querySelectorAll("output");
              return {
                mode: selectedOutput!.getAttribute("data-mode"),
                value: selectedOutput!.getAttribute("data-value"),
                text: selectedOutput!.textContent,
                valid: (selectedOutput as unknown as Element & { validity: ValidityState }).validity.valid,
                amount: numericOutput!.getAttribute("data-amount"),
              };
            });
            const [native, converted] = await Promise.all([read(live), read(react)]);
            assert.deepEqual(converted, native, `selected=${selected}, incoming=${String(incoming)}`);
            assert.deepEqual(native, selected === "text"
              ? { mode: "text", value: "hello", text: "Reading", valid: true, amount: "2" }
              : { mode: "number", value: "2", text: "Reading", valid: true, amount: "2" });
            await assertPixelsEqual(react, await react.locator("section").screenshot(),
              await live.locator("section").screenshot(), "React selected-bound prop pixels differ", live);
          }
        } finally {
          await live.close(); await react.close(); await browser.close();
        }
      });
      it(`${engine} ${mode} checks a prop against a state-selected type`, async () => {
        const browser = await launchParityBrowser(browserType);
        const live = await browser.newPage();
        const react = await browser.newPage();
        try {
          await live.setContent(`${stateReading}<main><x-state-reading value="2"></x-state-reading></main>`);
          await live.addScriptTag({ path: liveBundle });
          await live.evaluate(() => window.HtmlRuntime.lowerDocument());
          await live.evaluate(() => (window.HtmlRuntime as typeof window.HtmlRuntime & {
            updateComponentProps(element: Element, props: Record<string, unknown>): void;
          }).updateComponentProps(document.querySelector("button")!, { value: 2 }));
          const output = bundles.get(mode)!;
          await react.setContent(`<style>${output.css}</style><main></main>`);
          await react.addScriptTag({ path: output.browser });
          await react.evaluate(() => window.setStateReading(2));
          await react.locator("button").waitFor({ state: "attached" });
          const read = (page: Page) => page.locator("button").evaluate((element) => ({
            mode: element.getAttribute("data-mode"), value: element.querySelector("span")!.getAttribute("data-value"),
            title: element.querySelector("span")!.getAttribute("title"),
            text: element.querySelector("span")!.textContent,
            valid: (element as unknown as Element & { validity: ValidityState }).validity.valid,
          }));
          const compare = async (expected: { mode: string; value: string | null; title: string | null; text: string | null; valid: boolean }) => {
            await Promise.all([live, react].map((page) => page.evaluate(() => new Promise<void>((done) =>
              requestAnimationFrame(() => requestAnimationFrame(() => done()))))));
            const [native, converted] = await Promise.all([read(live), read(react)]);
            assert.deepEqual(native, expected);
            assert.deepEqual(converted, native);
            await assertPixelsEqual(react, await react.locator("button").screenshot(),
              await live.locator("button").screenshot(), "React state-selected prop pixels differ", live);
          };
          await compare({ mode: "number", value: "2", title: "two", text: "2", valid: true });
          await live.locator("button").click();
          await react.locator("button").click();
          await compare({ mode: "text", value: "2", title: "two", text: "2", valid: false });
          await live.evaluate(() => (window.HtmlRuntime as typeof window.HtmlRuntime & {
            updateComponentProps(element: Element, props: Record<string, unknown>): void;
          }).updateComponentProps(document.querySelector("button")!, { value: 42 }));
          await react.evaluate(() => window.setStateReading(42));
          await compare({ mode: "text", value: "2", title: "two", text: "2", valid: false });
          await live.evaluate(() => (window.HtmlRuntime as typeof window.HtmlRuntime & {
            updateComponentProps(element: Element, props: Record<string, unknown>): void;
          }).updateComponentProps(document.querySelector("button")!, { value: "hello" }));
          await react.evaluate(() => window.setStateReading("hello"));
          await compare({ mode: "text", value: "hello", title: "other", text: "hello", valid: true });
        } finally {
          await live.close(); await react.close(); await browser.close();
        }
      });
    }
  }
});

declare global {
  interface Window {
    HtmlRuntime: { lowerDocument(): void };
    setIncoming: (incoming: unknown) => void;
    setModeCase: (mode: string, incoming: unknown) => void;
    setStateReading: (value: unknown) => void;
  }
}
