import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { parseComponent } from "@nextwebwg/html-next";
import { browserSources } from "../src/browser.js";
import type { BrowserDefinition } from "../src/types.js";

const component = (tag: string, template: string, css = ""): BrowserDefinition => ({
  definition: parseComponent(`<template component="${tag}">${template}</template>`, `file:///components/${tag}.html`),
  styles: { css, stateNames: [] },
});

describe("HTMLKit shared client selection", () => {
  it("retains navigation layers and future invocations while omitting unused linked factories", () => {
    const sources = browserSources([
      component("x-page", '<main><x-label $if="false"></x-label></main>'),
      component("x-label", "<span>Later</span>"),
      component("x-unused", "<aside>Unused</aside>", "aside { color: red }"),
    ], { base: "/", prefetch: "none" }, "virtual:test-page", [], ["x-page"]);
    const entry = sources.get("virtual:test-page")!;
    assert.match(entry, /import \{ createXPage as c\d+ \}/);
    assert.match(entry, /import \{ createXLabel as c\d+ \}/);
    assert.doesNotMatch(entry, /createXUnused/);
    assert.match(entry, /x-unused\.html\.htmlkit\.css/);
  });

  it("preserves the conservative all-entry default for callers without layer information", () => {
    const entry = browserSources([component("x-a", "<div></div>"), component("x-b", "<div></div>")],
      { base: "/", prefetch: "none" }, "virtual:test-page").get("virtual:test-page")!;
    assert.match(entry, /createXA as/);
    assert.match(entry, /createXB as/);
  });
});
