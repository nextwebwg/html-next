import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";

import { build } from "esbuild";
import { chromium, firefox, webkit, type BrowserType } from "playwright";

const enabled = process.env.HTMLNEXT_BROWSER_TEST === "1";
const moduleUrl = new URL("../src/validity.ts", import.meta.url);

describe.skipIf(!enabled)("browser validity", () => {
  let bundlePath = "";
  let temporaryDirectory = "";

  beforeAll(async () => {
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

  afterAll(async () => {
    if (temporaryDirectory !== "") await rm(temporaryDirectory, { recursive: true, force: true });
  });

  const engines: ReadonlyArray<[string, BrowserType]> = [
    ["Chromium", chromium], ["Firefox", firefox], ["WebKit", webkit],
  ];

  for (const [name, browserType] of engines) {
    it(`${name}: gives ordinary elements a native-shaped, independently layered validity API`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent(
          `<style>#field:invalid { outline: 2px solid red } #field:user-invalid { color: rgb(255, 0, 0) }</style>` +
          `<form id="form"><div id="field" tabindex="0"></div><button>Send</button></form>`,
        );
        await page.addScriptTag({ path: bundlePath });
        await page.evaluate("globalThis.__name = (value) => value");
        const result = await page.evaluate(() => {
          const V = (window as unknown as { V: typeof import("../src/validity.js") }).V;
          const field = document.getElementById("field")! as HTMLElement & {
            validity: import("../src/validity.js").GeneralizedValidityState;
            validationMessage: string;
            checkValidity(): boolean;
            reportValidity(): boolean;
            setCustomValidity(message: string): void;
            setValidity(errors?: readonly import("../src/validate.js").ValidityError[]): void;
          };
          const form = document.getElementById("form") as HTMLFormElement;
          let value = "";
          let invalidEvents = 0;
          field.addEventListener("invalid", () => { invalidEvents += 1; });
          V.manageElementValidity(field, { required: true, type: "email" }, { value: () => value });

          const initial = {
            valid: field.validity.valid,
            missing: field.validity.valueMissing,
            userInvalid: field.matches(":is(:user-invalid, [data-user-invalid])"),
            styled: getComputedStyle(field).outlineStyle,
            enumerable: Object.keys(field).includes("validity"),
          };
          const explicit = field.reportValidity();
          const explicitUserInvalid = getComputedStyle(field).color;
          value = "ada@example.com";
          field.dispatchEvent(new Event("input", { bubbles: true }));
          field.setValidity([{ reason: "schemaMismatch", message: "The server rejected this address.", path: "$.email" }]);
          const layered = {
            valid: field.validity.valid,
            custom: field.validity.customError,
            type: field.validity.typeMismatch,
            schema: field.validity.schemaMismatch,
            message: field.validationMessage,
          };
          field.setValidity();
          const cleared = { valid: field.validity.valid, userInvalid: field.hasAttribute("data-user-invalid") };

          value = "";
          field.dispatchEvent(new Event("input", { bubbles: true }));
          const submit = new SubmitEvent("submit", { bubbles: true, cancelable: true });
          form.dispatchEvent(submit);
          form.reset();
          return new Promise<Record<string, unknown>>((resolve) => queueMicrotask(() => resolve({
            initial, explicit, explicitUserInvalid, layered, cleared,
            submitPrevented: submit.defaultPrevented,
            resetUserInvalid: field.hasAttribute("data-user-invalid"),
            invalidEvents,
            ariaInvalid: field.getAttribute("aria-invalid"),
          })));
        });

        assert.deepEqual(result.initial, {
          valid: false, missing: true, userInvalid: false, styled: "solid", enumerable: false,
        });
        assert.equal(result.explicit, false);
        assert.equal(result.explicitUserInvalid, "rgb(255, 0, 0)");
        assert.deepEqual(result.layered, {
          valid: false, custom: false, type: false, schema: true,
          message: "The server rejected this address.",
        });
        assert.deepEqual(result.cleared, { valid: true, userInvalid: false });
        assert.equal(result.submitPrevented, true);
        assert.equal(result.resetUserInvalid, false);
        assert.equal(result.invalidEvents, 2);
        assert.equal(result.ariaInvalid, "true");
      } finally {
        await browser.close();
      }
    });

    it(`${name}: preserves native email validation and form submission`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent(`<form id="form"><input id="email" type="email" required value="bad"><button>Send</button></form>`);
        await page.addScriptTag({ path: bundlePath });
        await page.evaluate("globalThis.__name = (value) => value");
        const result = await page.evaluate(() => {
          const V = (window as unknown as { V: typeof import("../src/validity.js") }).V;
          const input = document.getElementById("email") as HTMLInputElement;
          const form = document.getElementById("form") as HTMLFormElement;
          V.manageElementValidity(input);
          const normalized = V.getElementValidityState(input);
          const before = {
            normalizedTypeMismatch: normalized.typeMismatch,
            nativeTypeMismatch: input.validity.typeMismatch,
            nativeCustomError: input.validity.customError,
            formValid: form.checkValidity(),
          };
          input.value = "ada@example.com";
          input.dispatchEvent(new Event("input", { bubbles: true }));
          const after = { normalizedValid: V.getElementValidityState(input).valid, formValid: form.checkValidity() };
          input.setCustomValidity("Native application error");
          input.dispatchEvent(new Event("input", { bubbles: true }));
          const nativeCustom = {
            custom: V.getElementValidityState(input).customError,
            message: input.validationMessage,
          };
          return { before, after, nativeCustom };
        });
        assert.deepEqual(result.before, {
          normalizedTypeMismatch: true, nativeTypeMismatch: true, nativeCustomError: false, formValid: false,
        });
        assert.deepEqual(result.after, { normalizedValid: true, formValid: true });
        assert.deepEqual(result.nativeCustom, { custom: true, message: "Native application error" });
      } finally {
        await browser.close();
      }
    });

    it(`${name}: drives ElementInternals for a form-associated custom element`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent(`<form id="form"><x-field id="field"></x-field></form>`);
        await page.addScriptTag({ path: bundlePath });
        await page.evaluate("globalThis.__name = (value) => value");
        const result = await page.evaluate(() => {
          const V = (window as unknown as { V: typeof import("../src/validity.js") }).V;
          let value = "";
          let internals: ElementInternals | undefined;
          class XField extends HTMLElement {
            static formAssociated = true;
            constructor() {
              super();
              internals = this.attachInternals();
              V.manageElementValidity(this, { required: true }, { internals, value: () => value });
            }
          }
          customElements.define("x-field", XField);
          const field = document.getElementById("field")!;
          const form = document.getElementById("form") as HTMLFormElement;
          const invalid = { form: form.checkValidity(), aria: field.getAttribute("aria-invalid") };
          value = "present";
          V.refreshElementValidity(field);
          return { invalid, valid: form.checkValidity(), internalsValid: internals?.validity.valid };
        });
        assert.deepEqual(result, {
          invalid: { form: false, aria: "true" }, valid: true, internalsValid: true,
        });
      } finally {
        await browser.close();
      }
    });

    it(`${name}: mirrors dynamic and constructed validity CSS`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent(`<div id="field"></div>`);
        await page.addScriptTag({ path: bundlePath });
        await page.evaluate("globalThis.__name = (value) => value");
        const result = await page.evaluate(async () => {
          const V = (window as unknown as { V: typeof import("../src/validity.js") }).V;
          const field = document.getElementById("field")!;
          V.manageElementValidity(field, { required: true }, { value: () => "" });
          const style = document.createElement("style");
          style.textContent = `@media (min-width: 0px) { #field:not(:valid) { border-top: 3px solid rgb(1, 2, 3) } }`;
          document.head.append(style);
          await new Promise((resolve) => setTimeout(resolve, 0));
          const dynamic = getComputedStyle(field).borderTopWidth;

          const sheet = new CSSStyleSheet();
          document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
          sheet.replaceSync(`#field:invalid { padding-top: 7px }`);
          await new Promise((resolve) => setTimeout(resolve, 0));
          return { dynamic, constructed: getComputedStyle(field).paddingTop };
        });
        assert.deepEqual(result, { dynamic: "3px", constructed: "7px" });
      } finally {
        await browser.close();
      }
    });
  }
});
