import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "vitest";
import { parseComponentResource } from "../src/source-parser.js";
import { renderComponents } from "../src/server.js";
import { carrierHtml, visibleComponentHtml } from "./server-visible-html.js";

const fixtures = JSON.parse(await readFile(new URL("../../html-next-dotnet/tests/fixtures/iterations.json", import.meta.url), "utf8")) as readonly {
  name: string; source: string; expected: string; carrier?: string; error?: string;
}[];

describe("native and Node iteration fixtures", () => {
  it.each(fixtures)("renders $name", async ({ name, source, expected, carrier, error }) => {
    const result = renderComponents("<x-page></x-page>", { definitions: parseComponentResource(source, name + ".html").definitions });
    if (error !== undefined) { await assert.rejects(result, new RegExp(error)); return; }
    const { html } = await result;
    assert.equal(visibleComponentHtml(html), expected);
    if (carrier !== undefined) assert.equal(carrierHtml(html, "x-unused"), carrier);
  });

  it.each(["$loop", "$loop.index", "$index"])("rejects undeclared iteration name %s", (expression) => {
    assert.throws(() => parseComponentResource(`<template component="x-page"><main><b $each="row of [1]">{${expression}}</b></main></template>`, "undeclared.html"), /not declared/);
  });

  it.each(["row, row of [1]"])("rejects alias collision %s", (each) => {
    assert.throws(() => parseComponentResource(`<template component="x-page"><defs><state name="known" type="number" value="1"></state></defs><main><b $each="${each}"></b></main></template>`, "collision.html"), /distinct/);
  });

  it("rejects duplicate keys without poisoning later renders", async () => {
    const definitions = parseComponentResource('<template component="x-page"><defs><prop name="rows" type="list(number)">Rows.</prop></defs><main><b $each="row of $rows" $key="$row">{$row}</b></main></template>', "duplicate-keys.html").definitions;
    await assert.rejects(renderComponents("<x-page></x-page>", { definitions, props: { "x-page": { rows: [0, -0] } } }), /duplicate key/);
    const { html } = await renderComponents("<x-page></x-page>", { definitions, props: { "x-page": { rows: [1, 2] } } });
    assert.equal(visibleComponentHtml(html), "<main><b>1</b><b>2</b></main>");
  });
});
