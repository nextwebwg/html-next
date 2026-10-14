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

it("scopes Svelte selectors by the hash Svelte gives the component's own markup", () => {
  const definition = parseComponent('<template component="x-svelte-scope"><div><p $html="\'<b>x</b>\'"></p><x-child></x-child><slot></slot></div></template>');
  const compiled = compileComponentStylesForSvelte(`:host, :host-state([open]) span { color: red; } .item ::before, p:after { color: blue; }
    :slotted(.projected) a::marker { color: green; } x-child { color: navy; } @keyframes spin { to { opacity: 0; } }`,
  { ...definition, declarations: [{ kind: "state", name: "open", type: "boolean" }] });
  const own = ':where(*, :global([data-html-next-owner~="x-svelte-scope"]))';
  const layout = (css: string): string => css.replace(/\s*([{}])\s*/g, "$1").replace(/\s+/g, " ");
  assert.equal(layout(compiled.css), layout(`@keyframes -global-spin { to { opacity: 0; } }
    @scope (.x-svelte-scope) to (.x-child) {
      :global(:scope), :global(:scope[data-x-svelte-scope-state~="open"] span)${own} { color: red; }
      :global(.item *)${own}::before, :global(p)${own}:after { color: blue; }
      :global(:is(.projected) a):not(:scope, * *, [data-html-next-owner~="x-svelte-scope"])::marker { color: green; }
      :global(:is(x-child, .x-child))${own} { color: navy; }
    }`));
  assert.equal(compiled.hashed, true);
  // Without slots nothing is projected, so the native scope alone bounds the rules and Svelte hashes nothing.
  const unslotted = compileComponentStylesForSvelte("span { color: red; }", parseComponent('<template component="x-plain"><p><span></span></p></template>'));
  assert.equal(layout(unslotted.css), layout("@scope (.x-plain) { :global(span) { color: red; } }"));
  assert.equal(unslotted.hashed, undefined);
  // Rules only for the root need no limits, so the invoked components carry no classes for them.
  const host = compileComponentStylesForSvelte(":host { color: red; }", parseComponent('<template component="x-host"><p><x-child></x-child></p></template>'));
  assert.equal(layout(host.css), layout("@scope (.x-host) { :global(:scope) { color: red; } }"));
  assert.deepEqual(host.components, []);
  assert.deepEqual(compiled.components, ["x-child"]);
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
      assert.match(result.css, compile === compileComponentStylesForBuild ? /:scope:where\(\[data-component~="x-style-contract"\]\)\.active/
        : /:scope\.active/);
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
  assert.match(result.css, /@scope \(\.x-style-contract\) \{\s*@media/);
  assert.match(result.css, /:scope::before/);
  assert.match(result.css, /\*::after/);
  assert.doesNotMatch(result.css.slice(result.css.indexOf("@scope")), /@keyframes/);
});

it("keeps a component type selector's namespace in Vue's class form", () => {
  const nested = parseComponent('<template component="x-ns"><div><x-ns-child></x-ns-child></div></template>');
  const css = compileComponentStylesForVue('@namespace n "http://www.w3.org/1999/xhtml"; :host:is(n|x-ns) { color: red; } *|x-ns-child { color: blue; }', nested).css;
  assert.match(css, /:is\((htmlnextns\w+)\|x-ns, \1\|\*\.x-ns\)/);
  assert.match(css, /:is\(\*\|x-ns-child, \*\|\*\.x-ns-child\)/);
  assert.doesNotMatch(css, /\|:is\(/);
});
