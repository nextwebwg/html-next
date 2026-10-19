import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { afterAll, describe, it } from "vitest";
import { parseComponent } from "../src/source-parser.js";
import { closeRenderWorkers, renderComponents } from "../src/server.js";

describe("await server rendering", () => {
  afterAll(closeRenderWorkers);
  for (const [type, attribute] of [["boolean", 'product="false"'], ["number", 'product="0"'], ["string", 'product=""'], ["list(number)", 'product="[]"']] as const) {
    it(`keeps the success branch for a supplied ${type} value`, async () => {
      const definition = parseComponent(`<template component="x-await"><defs><prop name="product" type="${type}">Product.</prop></defs><section><b $await="binding of $product" id="ready">Ready: {$binding.ready}</b><i $error>Error.</i><p $else>Loading.</p></section></template>`);
      const rendered = await renderComponents(`<x-await ${attribute}></x-await>`, { definitions: [definition] });
      const dom = new JSDOM(rendered.html);
      try {
        assert.equal(dom.window.document.querySelector("#ready")?.textContent, "Ready: true");
        assert.equal(dom.window.document.querySelector("i,p"), null);
      } finally { dom.window.close(); }
    });
  }

  it("treats an actual nullable null from a parent as available", async () => {
    const parent = parseComponent('<template component="x-parent"><defs><state name="product" type="object({ name: string })" nullable></state></defs><section><x-await from:product="$product"></x-await></section></template>');
    const child = parseComponent('<template component="x-await"><defs><prop name="product" type="object({ name: string })" nullable>Product.</prop></defs><article><b $await="$product">Ready.</b><p $else>Loading.</p></article></template>');
    const rendered = await renderComponents('<x-parent></x-parent>', { definitions: [parent, child] });
    const dom = new JSDOM(rendered.html);
    try { assert.equal(dom.window.document.querySelector("b")?.textContent, "Ready."); }
    finally { dom.window.close(); }
  });

  it("selects unresolved markup without pretending that a request is in flight", async () => {
    const definition = parseComponent('<template component="x-await"><defs><prop name="product" type="string">Product.</prop></defs><section><b $await="binding of $product">Ready.</b><p $else>Pending: {$binding.pending}</p></section></template>');
    const rendered = await renderComponents('<x-await></x-await>', { definitions: [definition] });
    const dom = new JSDOM(rendered.html);
    try {
      assert.equal(dom.window.document.querySelector("b"), null);
      assert.equal(dom.window.document.querySelector("p")?.textContent, "Pending: false");
    } finally { dom.window.close(); }
  });
});
