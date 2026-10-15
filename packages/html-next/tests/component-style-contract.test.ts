import assert from "node:assert/strict";
import { compileStyle } from "@vue/compiler-sfc";
import { compile as compileSvelte } from "svelte/compiler";
import { describe, it } from "vitest";

import { compileComponentStylesForBuild, compileComponentStylesForSvelte, compileComponentStylesForVue } from "../src/component-styles-build.js";
import { guardComponentPseudoElements, renameComponentPseudoClasses, restoreStatePseudoClasses, rewriteComponentSelector, stateAttributeValue } from "../src/component-styles.js";
import { parseComponent } from "../src/source-parser.js";

const compilers = [compileComponentStylesForBuild, compileComponentStylesForSvelte, compileComponentStylesForVue];

it("preserves an implicit universal selector before a descendant pseudo-element", () => {
  assert.equal(guardComponentPseudoElements(".item ::before"), '.item :where(:not([data-component], [data-slotted]))::before');
  assert.equal(guardComponentPseudoElements(".item > ::after"), '.item > :where(:not([data-component], [data-slotted]))::after');
});

it("scopes Svelte selectors by the hash Svelte gives the component's own markup", () => {
  const definition = parseComponent('<template component="x-svelte-scope"><div><p $html="\'<b>x</b>\'"></p><x-child></x-child><slot></slot></div></template>');
  const compiled = compileComponentStylesForSvelte(`:host, :host(:state(open)) span { color: red; } .item ::before, p:after { color: blue; }
    :slotted(.projected) a::marker { color: green; } x-child { color: navy; } @keyframes spin { to { opacity: 0; } }`,
  { ...definition, declarations: [{ kind: "state", name: "open", type: "boolean" }] });
  const own = ':where(*, :global([data-html-next-owner~="x-svelte-scope"]))';
  const layout = (css: string): string => css.replace(/\s*([{}])\s*/g, "$1").replace(/\s+/g, " ");
  assert.equal(layout(compiled.css), layout(`@keyframes -global-spin { to { opacity: 0; } }
    @scope (.x-svelte-scope) to (.x-child) {
      :global(:scope), :global(:scope[data-x-svelte-scope-state~="open"] span)${own} { color: red; }
      :global(.item *)${own}::before, :global(p)${own}:after { color: blue; }
      :global(:is(.projected) a):not(:scope, * *, [data-html-next-owner~="x-svelte-scope"])::marker { color: green; }
      :global(:is(x-child, :where(.x-child)))${own} { color: navy; }
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
      const result = compile(':host([size="md"]) { color: blue; } :host(:state(open)) { color: red; } :host(:state(closed)) { color: green; }', definition);
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
        : compile === compileComponentStylesForVue ? /:scope:where\(:scope\):is\(\.active\)/ : /:scope\.active/);
    }
  });

  it("requires props in :host([prop]) and mutable or computed state in :state()", () => {
    for (const compile of compilers) {
      assert.throws(() => compile(":host(:state(size)) { color: red; }", definition), /HY001.*:host\(\[size\]\)/);
      assert.throws(() => compile(":host([open]) { color: red; }", definition), /HY001/);
      assert.throws(() => compile(":host([missing]) { color: red; }", definition), /HY001/);
      assert.throws(() => compile(":host(:state(missing)) { color: red; }", definition), /HY001/);
    }
  });

  it("accepts only presence and equality tests for resolved values", () => {
    for (const compile of compilers) {
      assert.throws(() => compile(':host([size^="m"]) { color: red; }', definition), /HY002/);
      assert.throws(() => compile(':host(:state(open~=true)) { color: red; }', definition), /HY002/);
    }
  });

  it("accepts identifier and quoted values, repeated tests, props, and its own tag in :state()", () => {
    const tone = parseComponent(`<template component="x-tone"><defs>
      <prop name="size" type="keyword" values="sm, md" default="md">Size.</prop>
      <state name="tone" type="string" value="warm"></state>
      <state name="step" type="number" value="2"></state>
      <state name="open" type="boolean" value="false"></state>
    </defs><section></section></template>`);
    for (const compile of compilers) {
      const result = compile(`:host(:state(tone=warm)) { color: red; } :host(:state(tone="cool blue")) { color: blue; }
        :host(:state(step="2")) { color: green; } :host([size=sm]:state(open):state(tone='warm' of x-tone)) .label { color: navy; }`, tone);
      assert.deepEqual(result.stateNames, ["tone", "step", "size", "open"]);
      assert.match(result.css, /\[data-x-tone-state~="tone=warm"\]/);
      assert.match(result.css, /\[data-x-tone-state~="tone=cool%20blue"\]/);
      assert.match(result.css, /\[data-x-tone-state~="step=2"\]/);
      assert.match(result.css, /\[data-x-tone-state~="size=sm"\]\[data-x-tone-state~="open"\]\[data-x-tone-state~="tone=warm"\]/);
    }
  });

  it("rejects malformed :state() arguments, :host-state(), and other components' state", () => {
    for (const compile of compilers) {
      for (const malformed of [":state(step=2)", ":state(tone=)", ":state(open closed)", ":state(open of x)", ":state()"]) {
        assert.throws(() => compile(`:host(${malformed}) { color: red; }`, definition), /HY002.*quote a value/, malformed);
      }
      assert.throws(() => compile(":host-state([open]) { color: red; }", definition), /HY005.*:host\(:state\(name\)\)/);
      assert.throws(() => compile("x-child:state(open) + p { color: red; }", definition), /HY006/);
      assert.throws(() => compile(":host(:state(open of x-other)) { color: red; }", definition), /HY006/);
      assert.throws(() => compile(":host(:state(size)) { color: red; }", definition), /HY001.*:host\(\[size\]\)/);
      assert.throws(() => compile(":host([open]) { color: red; }", definition), /HY001.*:host\(:state\(open\)\)/);
    }
  });

  it("restores a browser-serialized :state() to its authored form", () => {
    const renamed = renameComponentPseudoClasses(':host(:state(tone="cool blue" of x-tone)) a, :state(open) { color: red; } /* :state(x y) */');
    assert.equal(restoreStatePseudoClasses(renamed), ':host(:state(tone="cool blue" of x-tone)) a, :state(open) { color: red; } /* :state(x y) */');
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
      assert.throws(() => compile(":host(:state(rows)) { color: red; }", structured), /HY002/);
      assert.throws(() => compile(":host(:state(entry)) { color: red; }", structured), /HY002/);
      assert.throws(() => compile(":host(:state(entries)) { color: red; }", structured), /HY002/);
      assert.throws(() => compile(":host(:state(sourceEvent)) { color: red; }", event), /HY002/);
    }
  });
});


it("keeps Vue grouping rules in the component scope and keyframes document-wide", () => {
  const result = compileComponentStylesForVue(`@keyframes pulse { from { opacity: 0; } to { opacity: 1; } }
    @media (min-width: 0px) { :host::before { animation: pulse 1s; } *::after { box-sizing: border-box; } }`, definition);
  assert.match(result.css, /^@keyframes pulse/);
  assert.match(result.css, /@scope \(\.x-style-contract\) \{\s*@media/);
  assert.match(result.css, /:scope:where\(:scope\)::before/);
  assert.match(result.css, /\*::after/);
  assert.doesNotMatch(result.css.slice(result.css.indexOf("@scope")), /@keyframes/);
});

it("puts Vue's scope attribute on a host subject in :where(), at the live runtime's specificity", () => {
  const button = parseComponent('<template component="ui-x"><button><slot></slot></button></template>');
  const css = compileComponentStylesForVue(`:host { color: red; } :host::after { content: "x"; } :host(.a) { color: blue; }
    .wide :host { color: red; } .wide :host::after { content: "x"; } .wide > :host(.a) { color: blue; }
    .wide :host(:not(.c)) { color: green; } .wide :host .in { color: navy; }`, button).css;
  const scoped = compileStyle({ source: css, filename: "ui-x.vue", id: "data-v-1", scoped: true }).code.replace(/\s+/g, " ");
  // Live: `:scope:where([data-component~="ui-x"])`, (0,1,0); `.a` and `.wide` add one class each.
  assert.equal(scoped, '@scope (.ui-x) {:scope:where([data-v-1]:scope) { color: red; }'
    + ':scope:where([data-v-1]:scope)::after { content: "x"; }'
    + ':scope:where([data-v-1]:scope):is(.a) { color: blue; }'
    + ':scope:where([data-v-1]:scope):is(.wide *) { color: red; }'
    + ':scope:where([data-v-1]:scope):is(.wide *)::after { content: "x"; }'
    + ':scope:where([data-v-1]:scope):is(.wide > .a) { color: blue; }'
    + ':scope:where([data-v-1]:scope):is(.wide :not(.c)) { color: green; }'
    + '.wide :scope .in[data-v-1] { color: navy; } }');
});

it("selects a component by tag with the live runtime's specificity in Vue and Svelte", () => {
  const card = parseComponent('<template component="ui-x"><p><x-kid></x-kid></p></template>');
  const css = ":host:is(ui-x) { color: red; } x-kid > b { color: blue; }";
  const vue = compileStyle({ source: compileComponentStylesForVue(css, card).css, filename: "ui-x.vue", id: "data-v-1", scoped: true }).code;
  const svelte = compileSvelte(`<p class="ui-x"><x-kid></x-kid><b></b></p><style>${compileComponentStylesForSvelte(css, card).css}</style>`,
    { css: "external", filename: "UiX.svelte" }).css!.code;
  // Live: `:is(x-kid, :where([data-component~="x-kid"]))`, the type selector's (0,0,1).
  assert.equal(vue.replace(/\s+/g, " "), "@scope (.ui-x) to (.x-kid) {:scope:where([data-v-1]:scope):is(:is(:is(ui-x, :where(.ui-x)))) { color: red; }"
    + ":is(x-kid, :where(.x-kid)) > b[data-v-1] { color: blue; } }");
  assert.equal(svelte.replace(/\s+/g, " "), "@scope (.ui-x) to (.x-kid) {:scope:is(:is(ui-x, :where(.ui-x))) { color: red; }"
    + ":is(x-kid, :where(.x-kid)) > b { color: blue; } }");
});

it("keeps a nested Vue rule's own declarations at its specificity", () => {
  const button = parseComponent('<template component="ui-x"><button><b></b></button></template>');
  const css = compileComponentStylesForVue(":host { color: red; & b { color: blue; } @media (min-width: 0px) { margin: 0; } padding: 0; }", button).css;
  const scoped = compileStyle({ source: css, filename: "ui-x.vue", id: "data-v-1", scoped: true }).code.replace(/\s+/g, " ");
  // Vue's own wrapper would be `&[data-v-1] { … }`, one class heavier than the rule.
  assert.equal(scoped, "@scope (.ui-x) {:scope:where(:scope) { :where(&[data-v-1]):is(&) { color: red; padding: 0; } & b[data-v-1] { color: blue; }"
    + " @media (min-width: 0px) {:where(&[data-v-1]):is(&) { margin: 0; } } } }");
});

it("keeps a component type selector's namespace in Vue's class form", () => {
  const nested = parseComponent('<template component="x-ns"><div><x-ns-child></x-ns-child></div></template>');
  const css = compileComponentStylesForVue('@namespace n "http://www.w3.org/1999/xhtml"; :host:is(n|x-ns) { color: red; } *|x-ns-child { color: blue; }', nested).css;
  assert.match(css, /:is\((htmlnextns\w+)\|x-ns, :where\(\1\|\*\.x-ns\)\)/);
  assert.match(css, /:is\(\*\|x-ns-child, :where\(\*\|\*\.x-ns-child\)\)/);
  assert.doesNotMatch(css, /\|:is\(/);
});
