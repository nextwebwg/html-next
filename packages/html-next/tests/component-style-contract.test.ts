import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { compileComponentStylesForBuild, compileComponentStylesForSvelte, compileComponentStylesForVue } from "../src/component-styles-build.js";
import { guardComponentPseudoElements, rewriteComponentSelector, stateAttributeValue } from "../src/component-styles.js";
import { parseComponent } from "../src/source-parser.js";

const compilers = [compileComponentStylesForBuild, compileComponentStylesForSvelte, compileComponentStylesForVue];

it("preserves an implicit universal selector before a descendant pseudo-element", () => {
  assert.equal(guardComponentPseudoElements(".item ::before"), '.item :where(:not([data-component], [data-slotted]))::before');
  assert.equal(guardComponentPseudoElements(".item > ::after"), '.item > :where(:not([data-component], [data-slotted]))::after');
});

it("preserves statement at-rule terminators in build styles", () => {
  const definition = parseComponent('<template component="import-demo"><div></div></template>');
  const compiled = compileComponentStylesForBuild('@layer one; @layer two; :host { color: red; }', definition).css;
  assert.match(compiled, /@layer one;/);
  assert.match(compiled, /@layer two;/);
  assert.match(compiled, /@scope/);
});

it("rejects unresolved imports instead of emitting an unscoped resource", () => {
  const definition = parseComponent('<template component="import-demo"><div></div></template>');
  for (const compile of compilers) assert.throws(() => compile('@import "one.css";', definition), /HY004.*loadNodeComponents/);
});
const definition = parseComponent(`<template component="x-style-contract"><defs>
  <prop name="size" type="keyword" values="sm, md" default="md">Size.</prop>
  <state name="open" type="boolean" value="false"></state>
  <computed name="closed" from="not $open"></computed>
</defs><section></section></template>`);
const resolved: Readonly<Record<string, unknown>> = { size: "md", open: false, closed: true };

describe("resolved prop and state selectors", () => {
  it("lowers prop tests, mutable state, and computed state to the same resolved-value tokens", () => {
    for (const compile of compilers) {
      const result = compile(':host([size="md"]) { color: blue; } :host-state([open]) { color: red; } :host-state([closed]) { color: green; }', definition);
      assert.deepEqual(result.stateNames, ["size", "open", "closed"]);
      assert.match(result.css, /\[data-x-style-contract-state~="size=md"\]/);
      assert.match(result.css, /\[data-x-style-contract-state~="open"\]/);
      assert.match(result.css, /\[data-x-style-contract-state~="closed"\]/);
      assert.equal(stateAttributeValue(result.stateNames, (name) => resolved[name]), "size size=md closed");
    }
  });

  it("keeps ordinary host class conditions on the root", () => {
    assert.equal(rewriteComponentSelector(":host(.active) > span", "x-style-contract", ":scope", new Set()), ":scope.active > span");
    for (const compile of compilers) {
      const result = compile(":host(.active) { color: blue; }", definition);
      assert.deepEqual(result.stateNames, []);
      assert.match(result.css, compile === compileComponentStylesForVue ? /:scope\.active/
        : /:scope:where\(\[data-component~="x-style-contract"\]\)\.active/);
    }
  });

  it("requires props in :host and mutable or computed state in :host-state", () => {
    for (const compile of compilers) {
      assert.throws(() => compile(":host-state([size]) { color: red; }", definition), /HY001.*:host\(\[size\]\)/);
      assert.throws(() => compile(":host([open]) { color: red; }", definition), /HY001/);
      assert.throws(() => compile(":host([missing]) { color: red; }", definition), /HY001/);
      assert.throws(() => compile(":host-state([missing]) { color: red; }", definition), /HY001/);
    }
  });

  it("accepts only presence and equality tests for resolved values", () => {
    for (const compile of compilers) {
      assert.throws(() => compile(':host([size^="m"]) { color: red; }', definition), /HY002/);
      assert.throws(() => compile(':host-state([open~="true"]) { color: red; }', definition), /HY002/);
    }
  });

  it("rejects structured props and state and native event values", () => {
    const structured = parseComponent(`<template component="x-style-contract"><defs>
      <prop name="items" type="list(string)" default="[]">Items.</prop>
      <state name="rows" type="list(string)" value="[]"></state>
      <computed name="entry" from="{ item: 'x' }"></computed>
      <computed name="entries" from="['x']"></computed>
    </defs><section></section></template>`);
    const event = { ...definition, declarations: [{ kind: "state" as const, name: "sourceEvent", type: "event" }] };
    for (const compile of compilers) {
      assert.throws(() => compile(":host([items]) { color: red; }", structured), /HY002/);
      assert.throws(() => compile(":host-state([rows]) { color: red; }", structured), /HY002/);
      assert.throws(() => compile(":host-state([entry]) { color: red; }", structured), /HY002/);
      assert.throws(() => compile(":host-state([entries]) { color: red; }", structured), /HY002/);
      assert.throws(() => compile(":host-state([sourceEvent]) { color: red; }", event), /HY002/);
    }
  });
});


it("keeps Vue grouping rules in the component scope and keyframes document-wide", () => {
  const result = compileComponentStylesForVue(`@keyframes pulse { from { opacity: 0; } to { opacity: 1; } }
    @media (min-width: 0px) { :host::before { animation: pulse 1s; } *::after { box-sizing: border-box; } }`, definition);
  assert.match(result.css, /^@keyframes pulse/);
  assert.match(result.css, /@scope \(\[data-component~="x-style-contract"\]\) to \(\[data-component\]\) \{\s*@media/);
  assert.match(result.css, /:scope::before/);
  assert.match(result.css, /\*::after/);
  assert.doesNotMatch(result.css.slice(result.css.indexOf("@scope")), /@keyframes/);
});
