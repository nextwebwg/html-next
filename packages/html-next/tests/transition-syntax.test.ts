import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { HtmlDiagnosticError } from "../src/diagnostics.js";
import { parseComponent, parseComponentResourceForCheck } from "../src/source-parser.js";
import type { ElementNode } from "../src/template.js";
import { generateComponent } from "../src/generate.js";
import { parseTransitionValue, transitionCss, transitionElements } from "../src/transition-syntax.js";

const component = (body: string, defs = "") =>
  `<template component="x-demo" status="early" summary="Transitions."><defs>` +
  `<state name="open" type="boolean" value="false"></state>` +
  `<state name="photos" type="list(object({ id: string }))" value="[]"></state>${defs}</defs>${body}</template>`;

const code = (run: () => unknown): string | undefined => {
  try {
    run();
  } catch (error) {
    if (error instanceof HtmlDiagnosticError) return error.diagnostic.code;
    throw error;
  }
  return undefined;
};

describe("transitions extension syntax", () => {
  it("records $transition unparsed and compiles $transition-name in the element's scope", () => {
    const definition = parseComponent(component(
      `<section><aside $if="$open" $transition=" fly 200ms ease-out ">x</aside>` +
      `<img $each="photo of $photos" $key="$photo.id" $transition-name="$photo.id"></section>`,
    ));
    const [aside, img] = definition.template.children as ElementNode[];
    assert.equal(aside!.transition?.value, "fly 200ms ease-out");
    assert.equal(aside!.transition?.name, undefined);
    assert.equal(img!.transition?.name, "$photo.id");
    assert.deepEqual(img!.transition?.namePlan?.dependencies, ["photo.id"]);
    assert.equal(transitionElements(definition).length, 2);
  });

  it("records where each element is, for diagnostics raised after parsing", () => {
    const definition = parseComponent(component(`<div>\n<p $transition="fade">x</p></div>`));
    const [first] = transitionElements(definition);
    assert.equal(first?.line, 2);
    assert.equal(typeof first?.column, "number");
  });

  it("checks $transition-name roots like any expression", () => {
    assert.equal(code(() => parseComponent(component(`<div><p $transition-name="$missing">x</p></div>`))), "HT003");
  });

  it("warns and drops the directives on a <template>, which has no box", () => {
    const source = component(`<div><template $if="$open" $transition="fade"><p>x</p></template></div>`);
    const checked = parseComponentResourceForCheck(source, "x-demo.html");
    assert.deepEqual(checked.diagnostics.map(({ code, severity }) => [code, severity]), [["HT026", "warning"]]);
    assert.equal(transitionElements(checked.definitions[0]!).length, 0);
  });

  it("keeps a slot's attribute rule", () => {
    assert.equal(code(() => parseComponent(component(`<div><slot $transition="fade"></slot></div>`))), "HT008");
  });
});

describe("$transition values", () => {
  it("reads the animation shorthand's parts in any order", () => {
    assert.deepEqual(parseTransitionValue("", "s"), {});
    assert.deepEqual(parseTransitionValue("fly", "s"), { keyframes: "fly" });
    assert.deepEqual(parseTransitionValue("fly 200ms ease-out", "s"), { keyframes: "fly", duration: 200, easing: "ease-out" });
    assert.deepEqual(parseTransitionValue("0.3s pop 50ms", "s"), { keyframes: "pop", duration: 300, delay: 50 });
    assert.deepEqual(parseTransitionValue("200ms cubic-bezier(0.2, 0, 0, 1)", "s"), { duration: 200, easing: "cubic-bezier(0.2, 0, 0, 1)" });
    assert.deepEqual(parseTransitionValue("my-slide steps(4, jump-end)", "s"), { keyframes: "my-slide", easing: "steps(4, jump-end)" });
  });

  it("rejects what the shorthand cannot mean", () => {
    for (const value of ["fly pop", "fly 1s 2s 3s", "ease ease-in", "none", "fly 200", "fly #fff"]) {
      assert.equal(code(() => parseTransitionValue(value, "s")), "HT025", value);
    }
  });
});

describe("compiled transitions", () => {
  const panel = component(
    `<section>\n<aside $if="$open" $transition="fly 200ms ease-out">x</aside>` +
    `<ul><li $each="photo of $photos" $key="$photo.id" $transition-name="$photo.id">y</li></ul></section>`,
  );
  const vanilla = (source: string, extensions?: readonly string[]) =>
    generateComponent(parseComponent(source, "x-demo.html"), extensions === undefined ? {} : { extensions })
      .find((artifact) => artifact.path === "vanilla/XDemo.js")!.content;

  it("fails HT024 where the build does not enable the extension, at the element", () => {
    assert.throws(() => vanilla(panel), (error: unknown) =>
      error instanceof HtmlDiagnosticError && error.diagnostic.code === "HT024" && error.diagnostic.line === 2 &&
      /extensions: \["transitions"\]/.test(error.diagnostic.message));
  });

  it("binds names and classes, registers the rules, and holds the instance's flush", () => {
    const module = vanilla(panel, ["transitions"]);
    assert.match(module, /^import \{[^}]*\bholdTransitions\b[^}]*\btransitionStyles\b[^}]*\} from "@nextwebwg\/html-next\/generated-runtime";$/m);
    assert.match(module, /^transitionStyles\(".*@keyframes hn-fly .*"\);$/m);
    assert.match(module, /style\.setProperty\("view-transition-class"/);
    assert.match(module, /transitionName\(readMember\(o, "id"\)\)/);
    // Only a flip builds or tears down the body, so only a flip marks the transition.
    assert.match(module, /if \(c & 1 && !\(v\[0\]\) !== !r\.b0\) \{\n(?:.*\n){2} *transitionChanged\(\);\n *\} else if \(r\.b0 !== undefined\) p1\(r\.b0, c, d\);/);
    assert.match(module, /transitionRows\(r\.L1\)/);
    assert.match(module, /^  holdTransitions\(I, \d+\);$/m);
  });

  it("leaves a component without the directives exactly as it compiled before", () => {
    const plain = component(`<section><aside $if="$open">x</aside></section>`);
    const enabled = vanilla(plain, ["transitions"]);
    assert.equal(enabled, vanilla(plain));
    assert.doesNotMatch(enabled, /transition/i);
  });

  it("rejects a malformed value only where it is built", () => {
    const malformed = component(`<div><p $if="$open" $transition="fly 200">x</p></div>`);
    assert.equal(code(() => parseComponent(malformed)), undefined);
    assert.equal(code(() => vanilla(malformed, ["transitions"])), "HT025");
  });

  it("animates arriving, leaving and moving elements by class", () => {
    assert.equal(transitionCss({}, "c"), "");
    assert.equal(transitionCss({ duration: 300 }, "c"), "::view-transition-group(.c) { animation-duration: 300ms; }");
    const css = transitionCss({ keyframes: "fade" }, "c");
    assert.match(css, /@keyframes hn-fade \{ from \{ opacity: 0; \} \}/);
    assert.match(css, /::view-transition-new\(\.c\):only-child \{ animation: hn-fade 250ms ease 0ms both; \}/);
    assert.match(css, /::view-transition-old\(\.c\):only-child \{ animation: hn-fade 250ms ease 0ms both reverse; \}/);
    // An author's keyframes keep their own name and are not redefined.
    assert.doesNotMatch(transitionCss({ keyframes: "pop" }, "c"), /@keyframes/);
  });
});
