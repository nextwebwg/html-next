/**
 * HTML Next in-browser conformance harness.
 *
 * Runs the shared `source -> expected observable result` corpus (`test/conformance/cases.ts`)
 * against the in-browser compilation path (`src/runtime.ts`, `lowerDocument`) in Chromium,
 * Firefox, and WebKit, on the model of web-platform-tests. Every case is full HTML; the runtime
 * is bundled once (esbuild, iife, globalName `HtmlRuntime`) and injected per case.
 *
 * Gated behind `HTMLNEXT_BROWSER_TEST=1` so the default `npm test` stays green without browsers.
 * Run with:  HTMLNEXT_BROWSER_TEST=1 node --import tsx --test test/conformance.test.ts
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { build } from "esbuild";
import { chromium, firefox, webkit, type Browser, type BrowserType, type Page } from "playwright";

import { cases, type ConformanceCase } from "./conformance/cases.js";

const enabled = process.env.HTMLNEXT_BROWSER_TEST === "1";
const runtimeUrl = new URL("../src/runtime.ts", import.meta.url);

/** The in-page runner: lower, then either capture the diagnostic code or run the success probe. */
function pageProgram(testCase: ConformanceCase): string {
  const isDiagnostic = "code" in testCase.expect;
  const tail = isDiagnostic
    ? `return { code: __code };`
    : `if (__code !== null) return { unexpectedError: __code };\n${(testCase.expect as { probe: string }).probe}`;
  return `(() => {
    function snapshot(node) {
      if (node.nodeType === Node.TEXT_NODE) return { text: node.textContent };
      return {
        tag: node.localName,
        attributes: Array.from(node.attributes)
          .map((a) => [a.name, a.value])
          .sort((x, y) => x[0].localeCompare(y[0])),
        children: Array.from(node.childNodes)
          .filter((n) => !(n.nodeType === Node.TEXT_NODE && n.textContent.trim() === "") && n.nodeType !== Node.COMMENT_NODE)
          .map(snapshot),
      };
    }
    const q = (s) => document.querySelector(s);
    const qa = (s) => Array.from(document.querySelectorAll(s));
    let __code = null;
    try {
      window.HtmlRuntime.lowerDocument();
    } catch (error) {
      __code = (error && error.diagnostic && error.diagnostic.code) || ("THROWN: " + (error && error.message));
    }
    ${tail}
  })()`;
}

describe("conformance corpus (in-browser runtime)", { skip: !enabled }, () => {
  let bundlePath = "";
  let temporaryDirectory = "";

  before(async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "html-next-conformance-"));
    bundlePath = join(temporaryDirectory, "runtime.js");
    await build({
      entryPoints: [runtimeUrl.pathname],
      bundle: true,
      format: "iife",
      globalName: "HtmlRuntime",
      outfile: bundlePath,
      platform: "browser",
      target: ["es2022"],
    });
  });

  after(async () => {
    if (temporaryDirectory !== "") await rm(temporaryDirectory, { recursive: true, force: true });
  });

  const engines: ReadonlyArray<[string, BrowserType]> = [
    ["Chromium", chromium],
    ["Firefox", firefox],
    ["WebKit", webkit],
  ];

  for (const [engineName, browserType] of engines) {
    describe(engineName, () => {
      let browser: Browser;
      let page: Page;

      before(async () => {
        browser = await browserType.launch({ headless: true });
        page = await browser.newPage();
      });

      after(async () => {
        await browser?.close();
      });

      for (const testCase of cases) {
        it(testCase.name, async () => {
          await page.setContent(testCase.source);
          await page.addScriptTag({ path: bundlePath });
          const result = await page.evaluate(pageProgram(testCase));
          if ("code" in testCase.expect) {
            assert.deepEqual(result, { code: testCase.expect.code });
          } else {
            assert.deepEqual(result, testCase.expect.result);
          }
        });
      }
    });
  }
});
