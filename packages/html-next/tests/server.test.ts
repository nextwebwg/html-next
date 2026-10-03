import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { parseComponent } from "../src/source-parser.js";
import { renderComponents } from "../src/server.js";

const counter = parseComponent(`<template component="x-server-counter"><defs>
  <prop name="label" type="string" default="Counter">Label.</prop>
  <state name="count" type="number" value="0"></state>
  <handler name="increment"><set name="count" expr:value="count + 1"></set></handler>
</defs><section><h2 $value="label"></h2><button type="button" on:click="increment"><span $value="count"></span></button>
  <slot></slot></section><style>:host { display: block; }</style></template>`);

describe("Node component rendering", () => {
  it("renders inline paths as escaped text in mixed content and native table rows", async () => {
    const definition = parseComponent(String.raw`<template component="x-inline"><defs>
      <state name="rows" type="list(object({ id: number, name: string }))" value="[{ id: 1, name: '&lt;b&gt;Ada&lt;/b&gt;' }]"></state>
      </defs><section><p>Total: $rows.0.name due today. \$literal costs $1.15.</p>
      <table><tbody><tr $each="r of $rows" $key="$r.id"><td>$r.name</td></tr></tbody></table></section></template>`);
    const rendered = await renderComponents('<x-inline></x-inline>', { definitions: [definition] });
    assert.match(rendered.html, /Total: &lt;b&gt;Ada&lt;\/b&gt; due today\. \$literal costs \$1\.15\./);
    assert.match(rendered.html, /<td>&lt;b&gt;Ada&lt;\/b&gt;<\/td>/);
  });
  it("renders native HTML and styles without installing browser globals in Node", async () => {
    const before = Object.getOwnPropertyDescriptor(globalThis, "document");
    const rendered = await renderComponents('<x-server-counter label="Visits">Hello</x-server-counter>', {
      definitions: [counter],
    });
    assert.match(rendered.html, /<section[^>]*data-component="x-server-counter"/);
    assert.match(rendered.html, /<h2>Visits<\/h2>/);
    assert.match(rendered.html, /<span>0<\/span>/);
    assert.match(rendered.html, /<\?start slot=""\?>Hello<\?end\?>/);
    assert.match(rendered.css, /@scope/);
    assert.deepEqual(Object.getOwnPropertyDescriptor(globalThis, "document"), before);
  });

  it("renders independent requests concurrently with their own initial state", async () => {
    const outputs = await Promise.all([3, 8].map((count) => renderComponents('<x-server-counter id="counter"></x-server-counter>', {
      definitions: [counter],
      state: { "#counter": { count } },
    })));
    assert.match(outputs[0]!.html, /<span>3<\/span>/);
    assert.match(outputs[1]!.html, /<span>8<\/span>/);
  });

  it("renders the browser's declarative baseline before declared reads connect", async () => {
    const definition = parseComponent(`<template component="x-server-read"><defs>
      <data name="result" src="data:application/json,%22resolved%22" type="string"></data>
      </defs><section><output $if="result.pending">Loading</output>
      <b $if="result.ok" $value="result.value"></b></section></template>`);
    const rendered = await renderComponents("<x-server-read></x-server-read>", { definitions: [definition] });
    assert.match(rendered.html, /<output>Loading<\/output>/);
  });

  it("returns rendering diagnostics to the caller", async () => {
    await assert.rejects(renderComponents('<x-server-counter></x-server-counter>', {
      definitions: [counter, { ...counter, css: "changed" }],
    }), /HR001/);
  });

  it("keeps authored comments inert and avoids marker placeholder collisions", async () => {
    const rendered = await renderComponents('<div><!--html-next:serialized-mark:0--><!--?start slot="?>&lt;script&gt;alert(1)&lt;/script&gt;"?--></div>', {
      definitions: [],
    });
    assert.match(rendered.html, /<!--html-next:serialized-mark:0-->/);
    assert.equal(rendered.html.includes("<script>"), false);
    assert.match(rendered.html, /&lt;script&gt;/);
  });
});
