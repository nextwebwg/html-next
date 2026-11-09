import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "vitest";

import { parseComponentResource } from "../src/source-parser.js";
import { renderComponents } from "../src/server.js";
import { visibleComponentHtml } from "./server-visible-html.js";

const fixtures = JSON.parse(readFileSync(new URL("../../html-next-dotnet/tests/fixtures/accepted-child-lists.json", import.meta.url), "utf8")) as readonly {
  name: string; source: string; expected: string;
}[];
const cases = fixtures.filter(fixture => fixture.name.startsWith("plain-child-slot-shared-with-own-outlet-") || fixture.name === "plain-child-slot-repeated-own-outlets");
assert.equal(cases.length, 4);

describe("plain content shared by own and borrowed outlets", () => {
  for (const fixture of cases) it(fixture.name, async () => {
    const definitions = parseComponentResource(fixture.source, `${fixture.name}.html`).definitions;
    const rendered = await renderComponents("<x-page></x-page>", { definitions });
    assert.equal(visibleComponentHtml(rendered.html), fixture.expected);
  });
});

describe("ordinary repeated slots", () => {
  for (const name of ["", ' name="cell"']) it(`places plain content once for ${name === "" ? "default" : "named"} outlets`, async () => {
    const source = `<template component="x-card"><section><p><slot${name}>FirstFallback</slot></p><b><slot${name}>SecondFallback</slot></b></section></template><template component="x-page"><main><x-card><i${name === "" ? "" : ' slot="cell"'}>Plain</i></x-card></main></template>`;
    const definitions = parseComponentResource(source, "repeated-plain.html").definitions;
    assert.equal(visibleComponentHtml((await renderComponents("<x-page></x-page>", { definitions })).html), "<main><section><p><i" + (name === "" ? "" : ' slot="cell"') + ">Plain</i></p><b>SecondFallback</b></section></main>");
  });
  it("renders a consumer template afresh at repeated outlets", async () => {
    const definitions = parseComponentResource(`<template component="x-card"><section><p><slot name="cell">FirstFallback</slot></p><b><slot name="cell">SecondFallback</slot></b></section></template><template component="x-page"><main><x-card><template slot="cell"><i>Fresh</i></template></x-card></main></template>`, "repeated-template.html").definitions;
    assert.equal(visibleComponentHtml((await renderComponents("<x-page></x-page>", { definitions })).html), "<main><section><p><i>Fresh</i></p><b><i>Fresh</i></b></section></main>");
  });
  it("does not prepare a pending borrowed fallback when the child's own outlet stays inactive", async () => {
    const source = `<template component="x-never"><defs><context name="missing" from="x-no-provider"></context></defs><aside>{$missing}</aside></template>` + cases[0]!.source
      .replace('<slot name="cell">OwnFallback', '<slot name="cell" $if="false">OwnFallback')
      .replace("BorrowedFallback", "<x-never></x-never>");
    const definitions = parseComponentResource(source, "pending-plain.html").definitions;
    assert.equal(visibleComponentHtml((await renderComponents("<x-page></x-page>", { definitions })).html), '<main><section><b></b><p><i slot="cell">Plain</i></p></section></main>');
  });
});
