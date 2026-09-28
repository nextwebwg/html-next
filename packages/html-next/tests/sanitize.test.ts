import assert from "node:assert/strict";
import { beforeAll, describe, it } from "vitest";

import { build } from "esbuild";
import { chromium, firefox, webkit, type BrowserType } from "playwright";

import { sanitizeServerHTML } from "../src/sanitize-server.js";
import { SAFE_DEFAULT_ELEMENTS, SAFE_GLOBAL_ATTRIBUTES } from "../src/sanitizer-default.js";
import { cases, mutationInputs } from "./sanitize-cases.js";

const enabled = process.env.HTMLNEXT_BROWSER_TEST === "1";
const malformedTable = `<table id=x class=y title=z><b>Text</b></table>`;
const canonicalMalformedTable = `<b>Text</b><table title="z"></table>`;
const firefoxNativeMalformedTable = `<table title="z"></table><b>Text</b>`;
const differentialInputs = [
  ...Object.keys(SAFE_DEFAULT_ELEMENTS.html ?? {}),
  "audio", "button", "form", "iframe", "img", "input", "noscript", "option", "script", "select", "style", "template", "textarea", "video", "x-custom",
].map((tag) => `<${tag} id=x class=y title=z><b>Text</b></${tag}>`);

describe.skipIf(!enabled)("HTML Sanitizer safe default", () => {
  let source = "";

  beforeAll(async () => {
    const output = await build({
      entryPoints: [new URL("../src/sanitize.ts", import.meta.url).pathname],
      bundle: true,
      format: "iife",
      globalName: "HtmlSanitize",
      platform: "browser",
      target: ["es2022"],
      write: false,
    });
    source = output.outputFiles[0]!.text;
  });

  for (const [name, engine] of [["Chromium", chromium], ["Firefox", firefox], ["WebKit", webkit]] as const satisfies readonly [string, BrowserType][]) {
    it(`${name} applies the platform safe-default policy with deterministic parsing`, async () => {
      const browser = await engine.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.addScriptTag({ content: source });
        const nativePolicy = await page.evaluate(() => {
          const Constructor = Reflect.get(globalThis, "Sanitizer") as
            (new () => { get(): { attributes: { name: string }[]; elements: { name: string; namespace: string; attributes: { name: string }[] }[] } }) | undefined;
          return Constructor === undefined ? null : new Constructor().get();
        });
        if (nativePolicy !== null) {
          assert.deepEqual(nativePolicy.attributes.map(({ name }) => name), [...SAFE_GLOBAL_ATTRIBUTES]);
          const namespaces: Readonly<Record<string, string>> = {
            "http://www.w3.org/1999/xhtml": "html",
            "http://www.w3.org/2000/svg": "svg",
            "http://www.w3.org/1998/Math/MathML": "mathml",
          };
          const elements = { html: {}, svg: {}, mathml: {} } as Record<string, Record<string, string[]>>;
          for (const entry of nativePolicy.elements) elements[namespaces[entry.namespace]!]![entry.name] = entry.attributes.map(({ name }) => name);
          assert.deepEqual(elements, SAFE_DEFAULT_ELEMENTS);
        }
        const inputs = [...cases.map(({ input }) => input), ...differentialInputs];
        const results = await page.evaluate((inputs) => {
          const sanitize = (window as unknown as {
            HtmlSanitize: { sanitizeFragment(html: string, document: Document): DocumentFragment };
          }).HtmlSanitize.sanitizeFragment;
          return inputs.map(({ input, server }) => {
            const nativeSetHTML = (HTMLTemplateElement.prototype as HTMLTemplateElement & { setHTML?: (html: string) => void }).setHTML;
            const native = typeof nativeSetHTML === "function"
              ? (() => { const target = document.createElement("template"); nativeSetHTML.call(target, input); return target.innerHTML; })()
              : null;
            const target = document.createElement("div");
            target.append(sanitize(input, document));
            const canonical = target.innerHTML;
            const reparsed = document.createElement("template");
            reparsed.innerHTML = server;
            return { native, canonical, reparsed: reparsed.innerHTML };
          });
        }, inputs.map((input) => ({ input, server: sanitizeServerHTML(input) })));
        await page.evaluate((input) => {
          const prototype = HTMLTemplateElement.prototype as HTMLTemplateElement & { setHTML?: (html: string) => void };
          const original = Object.getOwnPropertyDescriptor(prototype, "setHTML");
          Object.defineProperty(prototype, "setHTML", {
            configurable: true,
            value: () => { throw new Error("$html must not call native setHTML()"); },
          });
          try {
            const sanitize = (window as unknown as {
              HtmlSanitize: { sanitizeFragment(html: string, document: Document): DocumentFragment };
            }).HtmlSanitize.sanitizeFragment;
            if (sanitize(input, document).firstElementChild?.localName !== "b") {
              throw new Error("Canonical $html parsing changed.");
            }
          } finally {
            if (original === undefined) delete prototype.setHTML;
            else Object.defineProperty(prototype, "setHTML", original);
          }
        }, malformedTable);
        const deviations: string[] = [];
        for (const [index, result] of results.entries()) {
          const expected = inputs[index] === malformedTable
            ? canonicalMalformedTable
            : index < cases.length ? cases[index]!.expected : result.native;
          if (expected !== null) {
            if (result.native !== null && result.native !== expected &&
              !(inputs[index] === malformedTable && name === "Firefox" && result.native === firefoxNativeMalformedTable)) {
              deviations.push(`${inputs[index]}: native ${JSON.stringify(result.native)} != ${JSON.stringify(expected)}`);
            }
            if (result.canonical !== expected) deviations.push(`${inputs[index]}: canonical ${JSON.stringify(result.canonical)} != ${JSON.stringify(expected)}`);
            if (result.reparsed !== expected) deviations.push(`${inputs[index]}: SSR ${JSON.stringify(result.reparsed)} != ${JSON.stringify(expected)}`);
          } else {
            if (result.reparsed !== result.canonical) deviations.push(`${inputs[index]}: SSR ${JSON.stringify(result.reparsed)} != canonical ${JSON.stringify(result.canonical)}`);
          }
        }
        assert.deepEqual(deviations, []);
        assert.equal(await page.evaluate(() => (window as unknown as { unsafeFlag?: number }).unsafeFlag), undefined);
      } finally {
        await browser.close();
      }
    });
    it(`${name} does not activate mutation-XSS payloads after server serialization and reparse`, async () => {
      const browser = await engine.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.addScriptTag({ content: source });
        const results = await page.evaluate((inputs) => inputs.map(({ input, server }) => {
          const sanitize = (window as unknown as {
            HtmlSanitize: { sanitizeFragment(html: string, document: Document): DocumentFragment };
          }).HtmlSanitize.sanitizeFragment;
          const target = document.createElement("div");
          target.append(sanitize(input, document));
          const reparsed = document.createElement("template");
          reparsed.innerHTML = server;
          const unsafe = (root: ParentNode): string[] => Array.from(root.querySelectorAll("*"))
            .flatMap((element) => [
              ...(["script", "style", "img", "iframe", "template"].includes(element.localName) ? [element.localName] : []),
              ...Array.from(element.attributes).filter((attribute) => /^on/i.test(attribute.name) || /^(?:javascript|vbscript):/i.test(attribute.value)).map(({ name }) => name),
            ]);
          return { client: target.innerHTML, server: reparsed.innerHTML, clientUnsafe: unsafe(target), serverUnsafe: unsafe(reparsed.content) };
        }), mutationInputs.map((input) => ({ input, server: sanitizeServerHTML(input) })));
        for (const result of results) {
          assert.equal(result.server, result.client);
          assert.deepEqual(result.clientUnsafe, []);
          assert.deepEqual(result.serverUnsafe, []);
        }
      } finally {
        await browser.close();
      }
    });
  }
});
