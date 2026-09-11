import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { build } from "esbuild";
import { chromium, firefox, webkit, type BrowserType } from "playwright";

const enabled = process.env.HTMLNEXT_BROWSER_TEST === "1";
const moduleUrl = new URL("../src/validity.ts", import.meta.url);

describe("browser validity", { skip: !enabled }, () => {
  let bundlePath = "";
  let temporaryDirectory = "";

  before(async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "html-next-validity-"));
    bundlePath = join(temporaryDirectory, "validity.js");
    await build({
      entryPoints: [moduleUrl.pathname],
      bundle: true,
      format: "iife",
      globalName: "V",
      outfile: bundlePath,
      platform: "browser",
      target: ["es2022"],
    });
  });

  after(async () => {
    if (temporaryDirectory !== "") {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  const engines: ReadonlyArray<[string, BrowserType]> = [
    ["Chromium", chromium],
    ["Firefox", firefox],
    ["WebKit", webkit],
  ];

  for (const [name, browserType] of engines) {
    it(`${name}: shims validity on a non-control element and clears it`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent(
          `<style>#field:invalid { outline: 2px solid red; } #field:user-invalid { color: rgb(255, 0, 0); }</style>` +
            `<div id="field" data-value="">content</div>`,
        );
        await page.addScriptTag({ path: bundlePath });
        const result = await page.evaluate(() => {
          const V = (window as unknown as { V: typeof import("../src/validity.js") }).V;
          const el = document.getElementById("field")!;
          let invalidEvents = 0;
          el.addEventListener("invalid", () => {
            invalidEvents += 1;
          });

          const invalid = V.validateElement(el, { required: true }); // empty + required
          const shimStyled = getComputedStyle(el).outlineStyle === "solid";
          const userInvalidStyled = getComputedStyle(el).color === "rgb(255, 0, 0)";
          const ariaWhenInvalid = el.getAttribute("aria-invalid");
          const message = V.validationMessage(el);

          el.setAttribute("data-value", "hello"); // fix the value
          const nowValid = V.validateElement(el, { required: true });
          const ariaWhenValid = el.getAttribute("aria-invalid");

          return {
            invalidValid: invalid.valid,
            invalidReason: invalid.errors[0]?.reason,
            shimStyled,
            userInvalidStyled,
            ariaWhenInvalid,
            message,
            invalidEvents,
            nowValidValid: nowValid.valid,
            ariaWhenValid,
          };
        });

        assert.equal(result.invalidValid, false);
        assert.equal(result.invalidReason, "missing");
        assert.equal(result.ariaWhenInvalid, "true");
        assert.equal(result.shimStyled, true, "authored :invalid CSS should apply");
        assert.equal(result.userInvalidStyled, true, "authored :user-invalid CSS should apply");
        assert.ok(result.message.length > 0);
        assert.equal(result.invalidEvents, 1);
        assert.equal(result.nowValidValid, true);
        assert.equal(result.ariaWhenValid, null);
      } finally {
        await browser.close();
      }
    });

    it(`${name}: delegates to native setCustomValidity on an <input>`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent(`<input id="email" value="nope">`);
        await page.addScriptTag({ path: bundlePath });
        const result = await page.evaluate(() => {
          const V = (window as unknown as { V: typeof import("../src/validity.js") }).V;
          const el = document.getElementById("email") as HTMLInputElement;

          V.setElementValidity(el, {
            valid: false,
            errors: [{ reason: "type", message: "Bad email." }],
          });
          const nativeInvalid = el.matches(":invalid");
          const customError = el.validity.customError;
          const nativeMessage = el.validationMessage;

          V.setElementValidity(el, { valid: true, errors: [] });
          const clearedInvalid = el.matches(":invalid");

          return { nativeInvalid, customError, nativeMessage, clearedInvalid };
        });

        assert.equal(result.nativeInvalid, true, "real :invalid via setCustomValidity");
        assert.equal(result.customError, true, "the legacy 'custom' bridge flag");
        assert.equal(result.nativeMessage, "Bad email.");
        assert.equal(result.clearedInvalid, false);
      } finally {
        await browser.close();
      }
    });
  }
});
