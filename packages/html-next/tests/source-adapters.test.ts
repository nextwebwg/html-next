import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";

import { build } from "esbuild";
import { chromium, firefox, webkit, type BrowserType } from "playwright";

import { parseSourceComponent } from "../src/source.js";
import { parseComponentResource } from "../src/source-graph.js";

const enabled = process.env.HTMLNEXT_BROWSER_TEST === "1";
const fixtureUrl = new URL("./fixtures/x-button.html", import.meta.url);
const browserSourceUrl = new URL("../src/browser-source.ts", import.meta.url);
const interfaceFixtures = JSON.parse(await readFile(new URL("../../html-next-dotnet/tests/fixtures/interface-declarations.json", import.meta.url), "utf8")) as { valid: readonly { source: string; name: string }[]; invalid: readonly { source: string; name: string; reason: string }[] };

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
    it(`${name} preserves inert consumer template source across source adapters`, async () => {
      const source = `<template component="x-page"><div><x-child><template slot="details"><!-- retained --><img src="lazy.png"><b $value="'Later'"></b><template slot="nested"><i>Inner</i></template></template></x-child></div></template>`;
      const expected = JSON.parse(JSON.stringify(parseSourceComponent(source, "lazy.html")));
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.addScriptTag({ path: bundlePath });
        const actual = await page.evaluate(source => (window as any).HtmlBrowserSource.parseBrowserComponentResource(source, "lazy.html", document).definitions[0], source);
        assert.deepEqual(actual, expected);
      } finally { await browser.close(); }
    });

    it(`${name} warns once and ignores invalid interface constraints and obsolete nullable markers`, async () => {
      const fixtures = interfaceFixtures.invalid.filter(entry => ["invalid-choice", "nullable-request", "nullable-state", "nullable-computed", "nullable-untyped-event"].includes(entry.name));
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.addScriptTag({ path: bundlePath });
        const results = await page.evaluate(fixtures => {
          const api = (window as any).HtmlBrowserSource;
          return fixtures.map(({ source, name }) => {
            const warnings: string[] = [];
            const warn = console.warn;
            console.warn = message => warnings.push(String(message));
            try {
              const definition = api.parseBrowserComponentResource(source, name + ".html", document).definitions[0];
              return { tag: definition.contract.tag, warnings };
            } finally { console.warn = warn; }
          });
        }, fixtures);
        assert.equal(results.length, 5);
        for (const [index, result] of results.entries()) {
          assert.equal(result.tag, "x-interface");
          assert.equal(result.warnings.length, 1, fixtures[index]!.name);
          assert.match(result.warnings[0]!, fixtures[index]!.name === "invalid-choice" ? /values/ : /nullable/);
        }
      } finally { await browser.close(); }
    });

    it(`${name} preserves event and request payload contracts through native parsing`, async () => {
      const expected = interfaceFixtures.valid.map(({ source, name }) => {
        const definition = parseSourceComponent(source, name + ".html");
        return JSON.parse(JSON.stringify({ events: definition.declarations?.filter(entry => entry.kind === "event"), requests: definition.contract.requests }));
      });
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.addScriptTag({ path: bundlePath });
        const actual = await page.evaluate(fixtures => {
          const api = (window as any).HtmlBrowserSource;
          return fixtures.map(({ source, name }) => {
            const definition = api.parseBrowserComponentResource(source, name + ".html", document).definitions[0];
            return JSON.parse(JSON.stringify({ events: definition.declarations?.filter((entry: any) => entry.kind === "event"), requests: definition.contract.requests }));
          });
        }, interfaceFixtures.valid);
        assert.deepEqual(actual, expected);
      } finally { await browser.close(); }
    });

    it(`${name} rejects native executable attribute bindings while preserving component inputs`, async () => {
      const body = (binding: string) => `<template component="x-events"><defs><state name="value" type="string" value=""></state></defs><div>${binding}</div></template>`;
      const sources = ["onclick", "onload", "onerror"].flatMap(attribute =>
        [body(`<button from:${attribute}="$value"></button>`), body(`<button bind:${attribute}="value"></button>`)]);
      sources.push(body('<x-child from:onclick="$value" bind:onload="value"></x-child>'));
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.addScriptTag({ path: bundlePath });
        const results = await page.evaluate(sources => {
          const api = (window as unknown as { HtmlBrowserSource: { parseBrowserComponentResource(source: string, url: string, document: Document): unknown } }).HtmlBrowserSource;
          return sources.map((source, index) => {
            try { api.parseBrowserComponentResource(source, `events-${index}.html`, document); return "ok"; }
            catch (error) { return (error as { diagnostic?: { code: string } }).diagnostic?.code; }
          });
        }, sources);
        assert.deepEqual(results, ["HT007", "HT007", "HT007", "HT007", "HT007", "HT007", "ok"]);
      } finally { await browser.close(); }
    });

    it(`${name} parses all definitions in a resource with the same names as the source parser`, async () => {
      const source = `<link rel="component" href="./shared.html">
        <template component="ui-button" status="early" summary="Button."><defs><title>Button title</title><meta name="description" content="Button metadata"></defs><button>Save</button></template>
        <template component="ui-select" status="early" summary="Select."><defs><link rel="canonical" href="/select/"></defs><select><slot></slot></select></template>`;
      const expected = JSON.parse(JSON.stringify(parseComponentResource(source, "library.html")));
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.addScriptTag({ path: bundlePath });
        const actual = await page.evaluate((source) => {
          const api = (window as unknown as { HtmlBrowserSource: {
            parseBrowserComponentResource(source: string, url: string, document: Document): unknown;
          } }).HtmlBrowserSource;
          return api.parseBrowserComponentResource(source, "library.html", document);
        }, source);
        assert.deepEqual(actual, expected);
      } finally {
        await browser.close();
      }
    });

    it(`${name} serializes the same normalized IR using native element and property introspection`, async () => {
      const fixture = await readFile(fixtureUrl, "utf8");
      const property = `<template component="x-check" status="experimental" summary="Check.">
        <defs><prop name="locked" type="boolean">Lock state.</prop></defs>
        <input .readonly="$locked">
      </template>`;
      const namespaced = '<template component="x-foreign"><div><svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><use xlink:href="#icon" xml:lang="en"></use></svg></div></template>';
      const sources = [fixture, property, namespaced];
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
