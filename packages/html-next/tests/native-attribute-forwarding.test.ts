import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "vitest";
import { JSDOM } from "jsdom";
import { parseComponentResource } from "../src/source-parser.js";
import { renderComponents } from "../src/server.js";
import { visibleComponentHtml } from "./server-visible-html.js";

const fixtures = JSON.parse(await readFile(new URL("../../html-next-dotnet/tests/fixtures/attribute-forwarding.json", import.meta.url), "utf8")) as readonly {
  name: string; source: string; expected: string;
}[];

describe("explicit attribute forwarding in native and Node rendering", () => {
  it("preserves empty custom properties and rejects declaration injection during keyed style writes", async () => {
    const source = `<template component="x-page"><main style="--empty: ; --count: 1; color: red" style:--count="3" style:--unsafe="'1; color: blue'">Styled</main></template>`;
    const { html } = await renderComponents("<x-page></x-page>", { definitions: parseComponentResource(source, "keyed-styles.html").definitions });
    const { window } = new JSDOM(html);
    try {
      const style = window.document.querySelector("main")!.style;
      assert.ok(Array.from(style).includes("--empty"));
      assert.equal(style.getPropertyValue("--count"), "3");
      assert.equal(style.getPropertyValue("--unsafe"), "");
      assert.equal(style.color, "red");
    } finally { window.close(); }
  });

  it.each(fixtures)("renders $name", async ({ name, source, expected }) => {
    const definitions = parseComponentResource(source, name + ".html").definitions;
    const { html } = await renderComponents("<x-page></x-page>", { definitions });
    assert.equal(visibleComponentHtml(html), expected);
  });

  it("resolves invocation style writes before the receiving component initializes state", async () => {
    const source = `<template component="x-subject"><defs>
      <prop name="style" type="string">Style text.</prop>
      <state name="initial" type="string" from="$style"></state>
      </defs><output from:data-initial="$initial">{$style}</output></template>
      <template component="x-page"><defs><state name="caller" type="string" from="'--caller: 9px; --local: 9px'"></state></defs>
      <main><x-subject from:style="$caller" style:--local="'2px'"></x-subject></main></template>`;
    const definitions = parseComponentResource(source, "invocation-style.html").definitions;
    const { html } = await renderComponents("<x-page></x-page>", { definitions });
    assert.equal(visibleComponentHtml(html), '<main><output data-initial="--caller: 9px; --local: 2px;">--caller: 9px; --local: 2px;</output></main>');
  });
});
