import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";

import { build } from "esbuild";
import { chromium, firefox, webkit, type BrowserType } from "playwright";

import { parseSourceComponent } from "../src/source.js";

const enabled = process.env.HTMLNEXT_BROWSER_TEST === "1";
const fixtureUrl = new URL("./fixtures/x-button.html", import.meta.url);
const browserSourceUrl = new URL("../src/browser-source.ts", import.meta.url);

describe.skipIf(!enabled)("source adapters", () => {
  let bundlePath = "";
  let temporaryDirectory = "";

  beforeAll(async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "html-next-source-adapters-"));
    bundlePath = join(temporaryDirectory, "browser-source.js");
    await build({
      entryPoints: [browserSourceUrl.pathname],
      bundle: true,
      format: "iife",
      globalName: "HtmlBrowserSource",
      outfile: bundlePath,
      platform: "browser",
      target: ["es2022"],
    });
  });

  afterAll(async () => {
    if (temporaryDirectory !== "") await rm(temporaryDirectory, { recursive: true, force: true });
  });

  const engines: ReadonlyArray<[string, BrowserType]> = [
    ["Chromium", chromium],
    ["Firefox", firefox],
    ["WebKit", webkit],
  ];

  for (const [name, browserType] of engines) {
    it(`${name} serializes the same normalized IR using native element and property introspection`, async () => {
      const fixture = await readFile(fixtureUrl, "utf8");
      const property = `<template component="x-check" status="experimental" summary="Check.">
        <defs><prop name="locked" type="boolean">Lock state.</prop></defs>
        <input .readonly="locked">
      </template>`;
      const sources = [fixture, property];
      const expected = sources.map((source, index) =>
        JSON.parse(JSON.stringify(parseSourceComponent(source, `source-${index}.html`)))
      );
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent(sources.map((source) => `<div>${source}</div>`).join(""));
        await page.addScriptTag({ path: bundlePath });
        const actual = await page.evaluate(() => {
          const api = (window as unknown as {
            HtmlBrowserSource: {
              parseBrowserComponent(carrier: Element, source: string): unknown;
            };
          }).HtmlBrowserSource;
          return Array.from(document.querySelectorAll("template[component]"), (carrier, index) =>
            api.parseBrowserComponent(carrier, `source-${index}.html`)
          );
        });
        assert.deepEqual(actual, expected);
      } finally {
        await browser.close();
      }
    });
  }
});
