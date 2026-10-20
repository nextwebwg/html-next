import assert from "node:assert/strict";
import { availableParallelism } from "node:os";
import { describe, it } from "vitest";
import { JSDOM } from "jsdom";

import { renderedInstanceRecord } from "../src/rendered-form.js";
import { parseComponent } from "../src/source-parser.js";
import { closeRenderWorkers, renderComponents, setRenderWorkers, type RenderedComponents } from "../src/server.js";

const counter = parseComponent(`<template component="x-server-counter"><defs>
  <prop name="label" type="string" default="Counter">Label.</prop>
  <state name="count" type="number" value="0"></state>
  <handler name="increment"><set name="count" expr:value="$count + 1"></set></handler>
</defs><section><h2 $value="$label"></h2><button type="button" on:click="increment"><span $value="$count"></span></button>
  <slot></slot></section><style>:host { display: block; }</style></template>`);

describe("Node component rendering", () => {
  it("accepts typed caller props before state initialization and records null separately from omission", async () => {
    const definition = parseComponent(`<template component="x-initial-props"><defs>
      <prop name="label" type="string" default="Default">Label.</prop>
      <state name="draft" type="string" from="$label"></state></defs>
      <article><h1>{$label}</h1><output>{$draft}</output></article></template>`);
    const rendered = await renderComponents('<x-initial-props id="typed" label="HTML"></x-initial-props><x-initial-props id="null" label="HTML"></x-initial-props><x-initial-props id="released" label="HTML"></x-initial-props><x-initial-props id="implicit"></x-initial-props>', {
      definitions: [definition], props: { "#typed": { label: "Typed" }, "#null": { label: null }, "#released": { label: undefined } },
    });
    const dom = new JSDOM(rendered.html);
    try {
      for (const [id, label, supplied] of [["typed", "Typed", true], ["null", "Default", true], ["released", "Default", false], ["implicit", "Default", false]] as const) {
        const root = dom.window.document.getElementById(id)!;
        assert.equal(root.querySelector("h1")!.textContent, label);
        assert.equal(root.querySelector("output")!.textContent, label);
        const input = renderedInstanceRecord(root, "x-initial-props")!.inputs.label!;
        assert.equal(input.provided ?? input.present, supplied);
        if (id === "null") assert.equal(input.value, null);
      }
    } finally { dom.window.close(); }
    await assert.rejects(renderComponents('<x-initial-props></x-initial-props>', { definitions: [definition], props: { "#missing": { label: "No" } } }), /matches no component/);
    await assert.rejects(renderComponents('<div id="plain"></div>', { definitions: [definition], props: { "#plain": { label: "No" } } }), /does not identify a component/);
    await assert.rejects(renderComponents('<x-initial-props id="wrong"></x-initial-props>', { definitions: [definition], props: { "#wrong": { unknown: true } } }), /declares no prop/);
  });
  it("renders braced inline expressions as escaped text in mixed content and native table rows", async () => {
    const definition = parseComponent(String.raw`<template component="x-inline"><defs>
      <state name="rows" type="list(object({ id: number, name: string }))" value="[{ id: 1, name: '&lt;b&gt;Ada&lt;/b&gt;' }]"></state>
      </defs><section><p>Total: {$rows.0.name} due today. $literal costs $1.15.</p>
      <table><tbody><tr $each="r of $rows" $key="$r.id"><td>{$r.name}</td></tr></tbody></table></section></template>`);
    const rendered = await renderComponents('<x-inline></x-inline>', { definitions: [definition] });
    assert.match(rendered.html, /Total: &lt;b&gt;Ada&lt;\/b&gt; due today\. \$literal costs \$1\.15\./);
    assert.match(rendered.html, /<td>&lt;b&gt;Ada&lt;\/b&gt;<\/td>/);
  });
  it("renders a component in a list row with structured props, including a component that renders itself", async () => {
    const definition = parseComponent(`<template component="x-tree"><defs>
      <prop name="items" type="list(object({ label: string, children: list(object({ label: string, ... })), ... }))" required>Items.</prop>
      </defs><ul><li $each="item of $items">{$item.label}<x-tree $if="$item.children.length" from:items="$item.children"></x-tree></li></ul></template>`);
    const items = JSON.stringify([{ label: "a", children: [{ label: "b", children: [{ label: "c", children: [] }] }] }]).replaceAll('"', "&quot;");
    const rendered = await renderComponents(`<x-tree items="${items}"></x-tree>`, { definitions: [definition] });
    const html = rendered.html.replace(/ data-[a-z-]+="[^"]*"/g, "").replace(/<!--[^>]*-->/g, "");
    assert.equal(html, "<ul><li>a<ul><li>b<ul><li>c</li></ul></li></ul></li></ul>");
    assert.doesNotMatch(rendered.html, /aria-invalid/);
  });
  it("never runs on:connect while rendering on the server", async () => {
    const definition = parseComponent(`<template component="x-connected"><defs><state name="connected" type="string" value="no"></state>
      <handler name="join"><set name="connected" value="yes"></set></handler></defs>
      <section on:connect="join" from:data-connected="$connected"></section></template>`);
    const rendered = await renderComponents("<x-connected></x-connected>", { definitions: [definition] });
    assert.match(rendered.html, /data-connected="no"/);
  });
  it("records explicit props under the component's tag, leaving authored data-* attributes as written", async () => {
    const definition = parseComponent(`<template component="x-figure"><defs>
      <prop name="placement" type="keyword" values="start, end" default="start">Where the figure floats.</prop>
      </defs><figure data-placement="figure"><slot></slot></figure></template>`);
    const rendered = await renderComponents('<x-figure placement="end"></x-figure><x-figure placement="end" data-placement="wide"></x-figure>',
      { definitions: [definition] });
    const roots = [...rendered.html.matchAll(/<figure[^>]*>/g)].map(([tag]) => tag);
    assert.equal(roots.length, 2);
    // The template's own data-placement and a consumer's pass-through keep their values; the prop has its own attribute.
    assert.match(roots[0]!, /\sdata-placement="figure"/);
    assert.match(roots[1]!, /\sdata-placement="wide"/);
    for (const root of roots) assert.match(root, /\sdata-x-figure-prop-placement="end"/);
  });
  it("keeps whitespace-only text between elements inside pre", async () => {
    const definition = parseComponent(`<template component="x-code"><pre class="shiki"><code><span class="line">a</span>
<span class="line">b</span></code></pre></template>`);
    const rendered = await renderComponents("<x-code></x-code>", { definitions: [definition] });
    assert.match(rendered.html, /<code><span class="line">a<\/span>\n<span class="line">b<\/span><\/code>/);
  });

  it("keeps whitespace-only text between inline elements and drops it among table rows", async () => {
    const definition = parseComponent(`<template component="x-package"><div><p><strong>Package:</strong> <code>x</code> and <em>a</em> <em>b</em></p>
      <table>
        <tr> <td>1</td> </tr>
      </table></div></template>`);
    const rendered = await renderComponents("<x-package></x-package>", { definitions: [definition] });
    assert.match(rendered.html, /<p><strong>Package:<\/strong> <code>x<\/code> and <em>a<\/em> <em>b<\/em><\/p>\n {6}<table><tbody><tr><td>1<\/td><\/tr><\/tbody><\/table><\/div>/);
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
    assert.deepEqual(rendered.styleOwnership, { "x-server-counter": [] });
    assert.deepEqual(Object.getOwnPropertyDescriptor(globalThis, "document"), before);
  });

  // Conflicting requests: one tag, two definitions, each with its own state and URL.
  const conflicting = (count: number) => renderComponents('<x-server-counter id="counter" label="Visits"></x-server-counter>', {
    definitions: [count % 2 === 0 ? counter : { ...counter, css: ":host { display: inline; }",
      template: { ...counter.template, attributes: [{ kind: "literal", name: "title", value: "odd" }] } } as typeof counter],
    state: { "#counter": { count } },
    url: `https://example.test/${count}/`,
  });
  const isolated = (output: RenderedComponents, count: number) => {
    assert.match(output.html, new RegExp(`<span>${count}</span>`));
    assert.equal(output.html.includes('title="odd"'), count % 2 === 1);
    assert.equal(output.css.includes("inline"), count % 2 === 1);
  };

  for (const workers of [1, 3]) {
    it(`renders independent requests with their own definitions and state, concurrently and in sequence, on ${workers} render worker${workers === 1 ? "" : "s"}`, async () => {
      setRenderWorkers(workers);
      try {
        // A shared registry would refuse the second definition of <x-server-counter> (HR001), and
        // shared instances would carry one request's count into another's.
        const counts = [3, 8, 5, 2, 7, 4];
        (await Promise.all(counts.map(conflicting))).forEach((output, i) => isolated(output, counts[i]!));
        for (const count of counts) isolated(await conflicting(count), count);
      } finally { setRenderWorkers(Math.min(availableParallelism(), 8)); }
    });
  }

  it("rejects the render of a worker that ends, and renders the next one on a new worker", async () => {
    // The rejection arrives while the workers end, so its handler is attached first.
    const lost = assert.rejects(conflicting(3), /exited without a result/);
    await new Promise((resolve) => setImmediate(resolve));
    await closeRenderWorkers();
    await lost;
    isolated(await conflicting(4), 4);
  });

  it("renders the browser's declarative baseline before declared reads connect", async () => {
    const definition = parseComponent(`<template component="x-server-read"><defs>
      <data name="result" src="data:application/json,%22resolved%22" type="string"></data>
      </defs><section><output $if="$result.pending">Loading</output>
      <b $if="$result.ok" $value="$result.value"></b></section></template>`);
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
