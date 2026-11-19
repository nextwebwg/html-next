import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "vitest";
import { JSDOM } from "jsdom";
import { parseComponentResource } from "../src/source-parser.js";
import { renderComponents } from "../src/server.js";
import { visibleComponentHtml } from "./server-visible-html.js";

const fixtures = JSON.parse(await readFile(new URL("../../html-next-dotnet/tests/fixtures/slot-rendering.json", import.meta.url), "utf8")) as readonly { name: string; source: string; entry: string; expected: string }[];

describe("native and Node visible slot projection fixtures", () => {
  it.each(fixtures)("renders $name", async ({ name, source, entry, expected }) => {
    const { html } = await renderComponents(`<${entry}></${entry}>`, { definitions: parseComponentResource(source, name + ".html").definitions });
    assert.equal(visibleComponentHtml(html), expected);
  });
});


it("preserves inert lazy template source in the serialized carrier", async () => {
  const source = `<template component="x-hidden"><div></div></template><template component="x-page"><article><x-hidden><template slot="details"><!-- retained --><img src="https://assets.example/lazy.png"><b $value="'Later'"></b><template slot="nested"><i>Inner</i></template></template></x-hidden></article></template>`;
  const { html } = await renderComponents("<x-page></x-page>", { definitions: parseComponentResource(source, "lazy-source.html").definitions });
  const dom = new JSDOM(html);
  try {
    const carrier = dom.window.document.querySelector<HTMLTemplateElement>('template[carrier="x-hidden"]')!;
    assert.equal(carrier.innerHTML, `<template slot="details"><!-- retained --><img src="https://assets.example/lazy.png"><b $value="'Later'"></b><template slot="nested"><i>Inner</i></template></template>`);
    assert.equal(dom.window.document.querySelectorAll("img, b, i").length, 0);
  } finally { dom.window.close(); }
});
