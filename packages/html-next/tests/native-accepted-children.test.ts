import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "vitest";
import { parseComponentResource } from "../src/source-parser.js";
import { renderComponents } from "../src/server.js";
import { visibleComponentHtml } from "./server-visible-html.js";

const fixtures = JSON.parse(await readFile(new URL("../../html-next-dotnet/tests/fixtures/accepted-children.json", import.meta.url), "utf8")) as readonly {
  name: string; source: string; expected: string; diagnostics: number;
}[];

describe("native and Node accepted child projection", () => {
  it.each(fixtures)("projects $name without requiring a child list", async ({ name, source, expected }) => {
    const { html } = await renderComponents("<x-page></x-page>", { definitions: parseComponentResource(source, name + ".html").definitions });
    assert.equal(visibleComponentHtml(html), expected);
    assert.doesNotMatch(html, /<template carrier="/);
  });

  it("keeps an unplaced accepted component deferred without an as list", async () => {
    const source = `<template component="x-column"><defs><prop name="label" type="string" required>Label.</prop></defs><b>{$label}</b></template>
      <template component="x-list"><defs><slot accepts="x-column"></slot></defs><section></section></template>
      <template component="x-page"><main><x-list><x-column></x-column></x-list></main></template>`;
    const { html } = await renderComponents("<x-page></x-page>", { definitions: parseComponentResource(source, "unplaced-accepted.html").definitions });
    assert.match(html, /<template carrier="x-list"><x-column><\/x-column><\/template>/);
    assert.doesNotMatch(html, /data-x-column|<b/);
  });
});
