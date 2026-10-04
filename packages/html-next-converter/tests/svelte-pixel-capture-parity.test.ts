import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";
import { describe, it } from "vitest";

import { assertPixelsEqual, launchParityBrowser } from "../../html-next/tests/pixel-parity.js";

describe.skipIf(process.env.HTMLNEXT_TARGET_TEST !== "1")("pixel capture settling", () => {
  for (const [engine, browserType] of [["Chromium", chromium], ["Firefox", firefox], ["WebKit", webkit]] as const) {
    it(`${engine} accepts stale frames only when recaptured pixels match exactly`, async () => {
      const browser = await launchParityBrowser(browserType);
      try {
        const actual = await browser.newPage();
        const expected = await browser.newPage();
        await actual.setContent('<div id="case" style="width:80px;height:40px;background:red"></div>');
        await expected.setContent('<div id="case" style="width:80px;height:40px;background:blue"></div>');
        const stale = await actual.locator("#case").screenshot({ animations: "disabled" });
        const reference = await expected.locator("#case").screenshot({ animations: "disabled" });
        await actual.locator("#case").evaluate((element) => { (element as HTMLElement).style.background = "blue"; });
        await assertPixelsEqual(actual, stale, reference, "stale capture", expected);
        await assertPixelsEqual(expected, reference, stale, "stale reference capture", actual);

        await actual.locator("#case").evaluate((element) => { (element as HTMLElement).style.background = "red"; });
        const different = await actual.locator("#case").screenshot({ animations: "disabled" });
        await assert.rejects(assertPixelsEqual(actual, different, reference, "persistent difference", expected),
          /persistent difference: 3200 differing RGBA pixels/);

        await actual.locator("#case").evaluate((element) => {
          (element as HTMLElement).style.background = "blue";
          element.innerHTML = '<span style="display:block;width:1px;height:1px;background:rgb(0,0,254)"></span>';
        });
        const oneChannel = await actual.locator("#case").screenshot({ animations: "disabled" });
        await assert.rejects(assertPixelsEqual(actual, oneChannel, reference, "one channel difference", expected),
          /one channel difference: 1 differing RGBA pixels.*max channel delta=1/);

        // An expected PNG without a live reference remains immutable even if the page later matches it.
        await actual.locator("#case").evaluate((element) => { element.innerHTML = ""; });
        await assert.rejects(assertPixelsEqual(actual, different, reference, "immutable reference"),
          /immutable reference: 3200 differing RGBA pixels/);
      } finally {
        await browser.close();
      }
    });
  }
});
