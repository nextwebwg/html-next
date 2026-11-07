import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "vitest";
import { parseComponentResource } from "../src/source-parser.js";
import { renderComponents } from "../src/server.js";
import { visibleComponentHtml } from "./server-visible-html.js";

const fixtures = JSON.parse(await readFile(new URL("../../html-next-dotnet/tests/fixtures/attribute-forwarding.json", import.meta.url), "utf8")) as readonly {
  name: string; source: string; expected: string;
}[];

describe("explicit attribute forwarding in native and Node rendering", () => {
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
