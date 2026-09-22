/**
 * `data-<tag>-state` exists for the names a definition's own stylesheet tests with
 * `:host-state()`, and for nothing else: a definition that styles no state carries no state
 * attribute at all, in any target. See nextwebwg.org/html-next/styling.
 */
import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { generateComponent } from "../src/generate.js";
import { parseComponent } from "../src/source-parser.js";

function generated(source: string): Map<string, string> {
  return new Map(
    generateComponent(parseComponent(source)).map((artifact) => [artifact.path, artifact.content]),
  );
}

const declarations = `<defs>
    <prop name="size" type="sm | md" default="md">Size.</prop>
    <state name="open" :value="false"></state>
  </defs>
  <section class="panel"><slot></slot></section>`;

describe("the state attribute", () => {
  it("is absent from every artifact when no rule tests a state", () => {
    const artifacts = generated(`<template component="x-quiet" status="experimental" summary="Declares state, styles none of it.">
      ${declarations}
      <style>:host { display: block; } .panel { padding: 1rem; }</style>
    </template>`);

    for (const [path, content] of artifacts) {
      assert.doesNotMatch(content, /data-x-quiet-state/, `${path} carries a state attribute no rule tests`);
    }
  });

  it("carries only the tested names, not every declared name", () => {
    const artifacts = generated(`<template component="x-loud" status="experimental" summary="Styles one of two names.">
      ${declarations}
      <style>:host-state([open]) .panel { display: block; }</style>
    </template>`);

    const css = artifacts.get("styles/x-loud.css")!;
    assert.match(css, /\[data-x-loud-state~="open"\]/);
    assert.doesNotMatch(css, /data-x-loud-state~="size/);
  });
});
