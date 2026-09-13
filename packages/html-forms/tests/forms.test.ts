import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";

import { build } from "esbuild";
import { chromium, type Browser } from "playwright";

const enabled = process.env.HTMLNEXT_BROWSER_TEST === "1";
const formsUrl = new URL("../src/index.ts", import.meta.url);

describe.skipIf(!enabled)("enhanced forms", () => {
  let browser: Browser;
  let bundlePath = "";
  let temporaryDirectory = "";

  beforeAll(async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "html-next-forms-"));
    bundlePath = join(temporaryDirectory, "forms.js");
    await build({
      entryPoints: [formsUrl.pathname],
      bundle: true,
      format: "iife",
      globalName: "HtmlNextForms",
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

  it("preserves successful controls, submitter, GET encoding, validation, and cancellation", async () => {
    const page = await browser.newPage();
    await page.setContent(
      `<form action="https://api.example/search" method="get">` +
        `<input name="q" required value="hello"><input name="off" disabled value="no">` +
        `<input type="checkbox" name="tag" value="web" checked>` +
        `<button name="intent" value="find">Find</button></form>`,
    );
    await page.addScriptTag({ path: bundlePath });
    const result = await page.evaluate(`(async () => {
      const calls = [];
      const states = [];
      const api = window.HtmlNextForms;
      const form = document.querySelector("form");
      const stop = api.enhanceForm(form, {
        fetch: async (input, init) => {
          const call = { url: String(input), aborted: false };
          calls.push(call);
          init?.signal?.addEventListener("abort", () => { call.aborted = true; });
          return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
        },
        onState(state) { states.push({ pending: state.pending, ok: state.ok }); },
      });
      const button = form.querySelector("button");
      form.requestSubmit(button);
      form.requestSubmit(button);
      for (let attempt = 0; attempt < 50 && !states.some((state) => state.ok); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      stop();
      return { calls, states, valid: form.checkValidity() };
    })()`) as {
      calls: Array<{ url: string; aborted: boolean }>;
      states: Array<{ pending: boolean; ok: boolean }>;
      valid: boolean;
    };
    await page.close();
    assert.deepEqual(result.calls.map(({ url }) => url), [
      "https://api.example/search?q=hello&tag=web&intent=find",
      "https://api.example/search?q=hello&tag=web&intent=find",
    ]);
    assert.equal(result.calls[0]?.aborted, true);
    assert.equal(result.valid, true);
    assert.deepEqual(result.states.at(-1), { pending: false, ok: true });
  });

  it("does not intercept an invalid form or a synchronously unavailable enhancer", async () => {
    const page = await browser.newPage();
    await page.setContent(`<form action="/native"><input name="q" required><button>Go</button></form>`);
    await page.addScriptTag({ path: bundlePath });
    const result = await page.evaluate(() => {
      const api = (window as unknown as {
        HtmlNextForms: { enhanceForm(form: HTMLFormElement, options: unknown): () => void };
      }).HtmlNextForms;
      const form = document.querySelector("form")!;
      api.enhanceForm(form, { fetch() { throw new Error("unavailable"); }, onState() {} });
      const invalid = new SubmitEvent("submit", { cancelable: true, submitter: form.querySelector("button") });
      form.dispatchEvent(invalid);
      form.querySelector("input")!.value = "ready";
      const unavailable = new SubmitEvent("submit", { cancelable: true, submitter: form.querySelector("button") });
      form.dispatchEvent(unavailable);
      return { invalidPrevented: invalid.defaultPrevented, unavailablePrevented: unavailable.defaultPrevented };
    });
    await page.close();
    assert.deepEqual(result, { invalidPrevented: false, unavailablePrevented: false });
  });
});
