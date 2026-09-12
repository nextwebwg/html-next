import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";

import { build } from "esbuild";
import { chromium, type Browser } from "playwright";

import { parseSourceComponent } from "../src/source.js";

const enabled = process.env.HTMLNEXT_BROWSER_TEST === "1";
const fixtureUrl = new URL("./fixtures/x-button.html", import.meta.url);
const browserSourceUrl = new URL("../src/browser-source.ts", import.meta.url);

describe.skipIf(!enabled)("source adapters", () => {
  let browser: Browser;
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
    browser = await chromium.launch({ headless: true });
  });

  afterAll(async () => {
    await browser?.close();
    if (temporaryDirectory !== "") await rm(temporaryDirectory, { recursive: true, force: true });
  });

  it("serializes the same normalized IR from authored source and a live DOM carrier", async () => {
    const source = await readFile(fixtureUrl, "utf8");
    const expected = JSON.parse(JSON.stringify(parseSourceComponent(source, "x-button.html")));
    const page = await browser.newPage();
    await page.setContent(source);
    await page.addScriptTag({ path: bundlePath });
    const actual = await page.evaluate(() => {
      const api = (window as unknown as {
        HtmlBrowserSource: {
          parseBrowserComponent(carrier: Element, source: string): unknown;
        };
      }).HtmlBrowserSource;
      return api.parseBrowserComponent(document.querySelector("template[component]")!, "x-button.html");
    });
    await page.close();
    assert.deepEqual(actual, expected);
  });
});
