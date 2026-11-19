import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { parseComponentResource } from "../src/source-parser.js";
import { renderComponents } from "../src/server.js";
import { visibleComponentHtml } from "./server-visible-html.js";

const column = `<template component="x-column"><defs><slot name="cell"><prop name="text" type="string">Cell text.</prop></slot></defs><span>Column</span></template>`;
const action = `<template component="x-action"><defs><slot name="cell"><prop name="text" type="integer">Cell number.</prop></slot></defs><span>Action</span></template>`;
const outlet = (expression: string) => `<slot of="${expression}" name="cell" text="7"><em>Empty</em></slot>`;
const lists = '<slot accepts="x-column" as="columns"></slot><slot name="actions" accepts="x-action" as="actions"></slot>';
function source(body: string, declarations = "", choose = false, accepted = lists): string {
  return `${column}${action}<template component="x-list"><defs><prop name="choose" type="boolean" default="false">Choose columns.</prop><prop name="position" type="integer" default="1">Index.</prop>${accepted}${declarations}</defs><section>${body}</section></template><template component="x-page"><main><x-list choose="${choose}"><x-column><template slot="cell">C:{$text}:{$text = '7'}</template></x-column><x-column><template slot="cell">C:{$text}:{$text = '7'}</template></x-column><x-action slot="actions"><template slot="cell">A:{$text}:{$text = '7'}</template></x-action></x-list></main></template>`;
}
async function output(markup: string): Promise<string> {
  const definitions = parseComponentResource(markup, "owned-entries.html").definitions;
  return visibleComponentHtml((await renderComponents("<x-page></x-page>", { definitions })).html);
}

describe("owned entry expressions", () => {
  it("places an indexed entry", async () => {
    assert.equal(await output(source(outlet("$columns[$position]"))), "<main><section>C:7:true</section></main>");
  });
  it("preserves a computed entry alias", async () => {
    assert.equal(await output(source(outlet("$chosen"), '<computed name="chosen" from="$columns[$position]"></computed>')), "<main><section>C:7:true</section></main>");
  });
  it("preserves with and match aliases", async () => {
    assert.equal(await output(source(`<template $with="$columns[1] as chosen">${outlet("$chosen")}</template>`)), "<main><section>C:7:true</section></main>");
    assert.equal(await output(source(`<template $match="$columns[1] as chosen"><template $when="true">${outlet("$chosen")}</template></template>`)), "<main><section>C:7:true</section></main>");
  });
  for (const choose of [false, true]) {
    it(`checks the selected child's slot props across two lists, choose=${choose}`, async () => {
      const expected = choose ? "C:7:true" : "A:7:false";
      const declarations = '<computed name="chosen" from="$choose ? $columns[1] : $actions[0]"></computed>';
      assert.equal(await output(source(outlet("$chosen"), declarations, choose)), `<main><section>${expected}</section></main>`);
    });
    it(`iterates an aliased list, choose=${choose}`, async () => {
      const declarations = '<computed name="chosen" from="$choose ? $columns : $actions"></computed>';
      assert.equal(await output(source(`<template $each="entry of $chosen">${outlet("$entry")}</template>`, declarations, choose)), `<main><section>${choose ? "C:7:trueC:7:true" : "A:7:false"}</section></main>`);
    });
  }
  it("keeps the component's list identity when an item shadows its name", async () => {
    assert.equal(await output(source(`<template $each="columns of $columns">${outlet("$columns")}</template>`)), "<main><section>C:7:trueC:7:true</section></main>");
  });
  it("retains entry identity in a new list and renders null fallback", async () => {
    assert.equal(await output(source(`<template $each="entry of [$columns[1], null, $actions[0]]">${outlet("$entry")}</template>`)), "<main><section>C:7:true<em>Empty</em>A:7:false</section></main>");
  });
  it("renders an absent or literal null entry as fallback", async () => {
    assert.equal(await output(source(outlet("$columns[99]"))), "<main><section><em>Empty</em></section></main>");
    assert.equal(await output(source(outlet("null"), "", false, "")), "<main><section><em>Empty</em></section></main>");
  });
  it("allows identity-preserving default expressions", async () => {
    assert.equal(await output(source(outlet("default($columns[99], $actions[0])"))), "<main><section>A:7:false</section></main>");
  });
  it("does not treat a copied record or a shadowing foreign value as an owned entry", () => {
    for (const body of [outlet("{ text: 'copy' }"), outlet("$choose ? $columns[0] : {}"), `<template $each="entry of [$columns[0], {}]">${outlet("$entry")}</template>`, `<template $with="[{ text: 'copy' }] as columns">${outlet("$columns[0]")}</template>`]) {
      assert.throws(() => parseComponentResource(source(body), "owned-entries.html"), /HT008: .*takes an entry/);
    }
  });
});
