import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { describe, it } from "vitest";
import { parseComponent } from "../src/source-parser.js";
import { parseBrowserComponent } from "../src/browser-source.js";
import type { ElementNode } from "../src/template.js";

const component = (markup: string) => `<template component="x-await"><defs><prop name="product" type="object({ name: string })">Product.</prop></defs><section>${markup}</section></template>`;
const native = (source: string) => {
  const dom = new JSDOM(source);
  try { return parseBrowserComponent(dom.window.document.querySelector("template")!, "component.html"); }
  finally { dom.window.close(); }
};

for (const [name, parse] of [["source", (source: string) => parseComponent(source, "component.html")], ["DOM", native]] as const) {
  describe(`${name} await parsing`, () => {
    it("groups concise sibling branches across whitespace and comments", () => {
      const definition = parse(component('<h2 $await="$product">{$product.name}</h2>\n<!-- error -->\n<p $error>Unavailable.</p>\n<p $else>Loading.</p><b>After</b>'));
      const group = definition.template.children[0] as ElementNode;
      assert.equal(group.flow?.kind, "with");
      if (group.flow?.kind !== "with") return;
      assert.deepEqual(group.flow.binding, { name: "product", handlesError: true });
      const match = group.children[0] as ElementNode;
      assert.equal(match.flow?.kind, "match");
      assert.equal(match.children.length, 3);
      assert.equal((definition.template.children[1] as ElementNode).name, "b");
    });

    it("scopes an explicitly typed status through the group and a named error to its branch", () => {
      const definition = parse(component('<template $await="binding of $product"><h2>{$product.name}</h2><small $if="$binding.pending">Refreshing.</small></template><p $error="problem">{$problem.message}: {$binding.pending}</p><p $else>{$binding.ready}</p>'));
      const group = definition.template.children[0] as ElementNode;
      assert.equal(group.flow?.kind === "with" && group.flow.alias, "binding");
      assert.equal(group.flow?.kind === "with" && group.flow.aliasType?.kind, "object");
      assert.throws(() => parse(component('<p $await="binding of $product">Ready.</p><p>{$binding.pending}</p>')), /not declared/);
      assert.throws(() => parse(component('<p $await="$product">{$problem.message}</p><p $error="problem">{$problem.message}</p>')), /not declared/);
      assert.throws(() => parse(component('<p $await="$product">{$__await0.ready}</p>')), /not declared/);
    });

    it("handles nested groups and table-context branch elements", () => {
      const definition = parse(component('<table><tbody><tr $await="binding of $product"><td><span $await="$product">{$product.name}</span><i $error>Nested error.</i></td></tr><tr $error><td>Unavailable.</td></tr><tr $else><td>Loading.</td></tr></tbody></table>'));
      assert.equal((definition.template.children[0] as ElementNode).name, "table");
    });

    it("rejects orphaned, repeated, misordered, invalid and colliding bindings", () => {
      for (const markup of [
        '<p $error>Orphan.</p>', '<p $else>Orphan.</p>',
        '<p $await="$product"></p><p $else></p><p $error></p>',
        '<p $await="$product"></p><p $error></p><p $error></p>',
        '<p $await="$product"></p>intervening<p $error></p>',
        '<p $await="$product"></p><p $else="unexpected"></p>',
        '<p $await="$missing"></p>', '<p $await="$product.name"></p>', '<p $await="fetch()"></p>',
        '<p $await="product of $product"></p>',
        '<p $await="binding of $product"></p><p $error="binding"></p>',
        '<p $await="$product"></p><p $error="product"></p>',
        '<p $await="$product" $if="true"></p>',
        '<p $await="$product"></p><p $error $if="true"></p>',
      ]) assert.throws(() => parse(component(markup)), Error, markup);
    });
  });
}
