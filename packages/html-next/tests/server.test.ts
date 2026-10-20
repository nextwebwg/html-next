import assert from "node:assert/strict";
import { availableParallelism } from "node:os";
import { once, getEventListeners } from "node:events";
import { MessageChannel } from "node:worker_threads";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it } from "vitest";
import { JSDOM } from "jsdom";

import { renderedInstanceRecord } from "../src/rendered-form.js";
import { parseComponent } from "../src/source-parser.js";
import { closeRenderWorkers, createRenderer, renderComponents, setRenderWorkers, type RenderedComponents } from "../src/server.js";

const counter = parseComponent(`<template component="x-server-counter"><defs>
  <prop name="label" type="string" default="Counter">Label.</prop>
  <state name="count" type="number" value="0"></state>
  <handler name="increment"><set name="count" expr:value="$count + 1"></set></handler>
</defs><section><h2 $value="$label"></h2><button type="button" on:click="increment"><span $value="$count"></span></button>
  <slot></slot></section><style>:host { display: block; }</style></template>`);

describe("Node component rendering", () => {
  const preparation = new URL("./fixtures/server-prepare.mjs", import.meta.url).href;
  const product = parseComponent(`<template component="x-prepared"><defs>
    <prop name="product" type="string">Product.</prop><state name="draft" type="string" from="$product"></state></defs>
    <section><h1 $await="$product">{$product}</h1><p $else>Waiting.</p><output>{$draft}</output>
    <x-server-counter $await="$product" from:label="$product"></x-server-counter></section></template>`);
  it("closes one renderer's active and queued work while another renderer completes its private read", async () => {
    const first = createRenderer({ workers: 1 }); const second = createRenderer({ workers: 1 });
    const ports = [new MessageChannel(), new MessageChannel(), new MessageChannel()];
    const started = once(ports[0]!.port1, "message");
    const closed = ports.slice(0, 2).map(channel => once(channel.port1, "close"));
    const stopped = assert.rejects(first.render("", { definitions: [], prepare: { module: preparation, port: ports[0]!.port2, data: { wait: true } } }), /exited without a result/);
    let queued: Promise<void> | undefined;
    let incoming: Promise<RenderedComponents> | undefined;
    try {
      await started;
      queued = assert.rejects(first.render("", { definitions: [], prepare: { module: preparation, port: ports[1]!.port2, data: { wait: true } } }), /exited without a result/);
      const requested = new Promise<void>(resolve => ports[2]!.port1.on("message", message => { if (message.event === "read") resolve(); }));
      incoming = second.render('<x-prepared id="subject"></x-prepared>', { definitions: [product, counter],
        prepare: { module: preparation, port: ports[2]!.port2, data: { query: "other" } } });
      void incoming.catch(() => {});
      await requested;
      await Promise.all([first.close(), first.close(), stopped, queued, ...closed]);
      await assert.rejects(first.render("", { definitions: [] }), /renderer is closed/);
      assert.throws(() => first.setWorkers(2), /renderer is closed/);
      const rejected = new MessageChannel();
      try {
        const rejectedClosed = once(rejected.port1, "close");
        await assert.rejects(first.render("", { definitions: [], prepare: { module: preparation, port: rejected.port2 } }), /renderer is closed/);
        await rejectedClosed;
      } finally { rejected.port1.close(); rejected.port2.close(); }
      ports[2]!.port1.postMessage("Other application");
      assert.match((await incoming).html, /<h1>Other application<\/h1>/);
      assert.match((await second.render('<x-server-counter></x-server-counter>', { definitions: [counter] })).html, /<h2>Counter<\/h2>/);
    } finally {
      await Promise.all([first.close(), second.close()]);
      await queued; await incoming?.catch(() => {});
      for (const channel of ports) { channel.port1.close(); channel.port2.close(); }
    }
  });
  it("owns its native ESM cache until close and imports edited adapters in a fresh renderer", async () => {
    const first = createRenderer({ workers: 1 }); const second = createRenderer({ workers: 1 });
    const directory = await mkdtemp(join(tmpdir(), "html-next-renderer-"));
    const entry = join(directory, "prepare.mjs");
    const adapter = (value: string) => `export function prepare({ document }) { document.body.append(document.createTextNode(${JSON.stringify(value)})); }`;
    const options = { definitions: [], prepare: { module: pathToFileURL(entry).href } };
    try {
      await writeFile(entry, adapter("First module"));
      assert.equal((await first.render("", options)).html, "First module");
      await writeFile(entry, adapter("Edited module"));
      assert.equal((await first.render("", options)).html, "First module");
      assert.equal((await second.render("", options)).html, "Edited module");
      await first.close();
      assert.equal((await second.render("", options)).html, "Edited module");
    } finally { await Promise.all([first.close(), second.close()]); await rm(directory, { recursive: true, force: true }); }
  });
  it("retires a completed excess worker before assigning queued work after a resize", async () => {
    const renderer = createRenderer({ workers: 2 });
    const module = new URL("./fixtures/server-worker-id.mjs", import.meta.url).href;
    const ports = [new MessageChannel(), new MessageChannel(), new MessageChannel()];
    const started = ports.map(channel => once(channel.port1, "message"));
    const options = (index: number) => ({ definitions: [], prepare: { module, port: ports[index]!.port2, data: { id: String(index) } } });
    const running = [renderer.render("", options(0)), renderer.render("", options(1))];
    let queued: Promise<RenderedComponents> | undefined;
    try {
      const [first, second] = (await Promise.all(started.slice(0, 2))).map(([message]) => message as { threadId: number });
      assert.notEqual(first!.threadId, second!.threadId);
      assert.throws(() => renderer.setWorkers(0), RangeError);
      renderer.setWorkers(1);
      ports[2]!.port1.on("message", () => ports[2]!.port1.postMessage("Continue"));
      queued = renderer.render("", options(2));
      ports[0]!.port1.postMessage("Continue");
      assert.equal((await running[0]!).html, "0");
      ports[1]!.port1.postMessage("Continue");
      assert.equal((await running[1]!).html, "1");
      const [last] = await started[2]!;
      assert.equal(last.threadId, second!.threadId);
      assert.equal((await queued).html, "2");
    } finally {
      await renderer.close();
      await Promise.all([...running, ...queued === undefined ? [] : [queued]].map(promise => promise.catch(() => {})));
      for (const channel of ports) { channel.port1.close(); channel.port2.close(); }
    }
  });
  it("prepares typed providers in the worker through a private message channel without connecting browser behavior", async () => {
    const { port1, port2 } = new MessageChannel();
    const messages: unknown[] = [];
    const closed = once(port1, "close");
    port1.on("message", message => { messages.push(message); if (message.event === "read") port1.postMessage("Prepared " + message.query); });
    const signal = new AbortController().signal;
    try {
      const result = await renderComponents('<x-prepared id="subject"></x-prepared>', { definitions: [product, counter], signal,
        prepare: { module: preparation, data: { query: "A" }, port: port2 } });
      await closed;
      assert.match(result.html, /<h1>Prepared A<\/h1>/);
      assert.match(result.html, /<output>Prepared A<\/output>/);
      assert.match(result.html, /<h2>Prepared A<\/h2>/);
      assert.match(result.html, /data-prepared="preparation-test"/);
      assert.doesNotMatch(result.html, /Waiting\./);
      assert.deepEqual(messages, [{ event: "start", query: "A" }, { event: "read", query: "A" }, { event: "cleanup", aborted: true }]);
      assert.equal(getEventListeners(signal, "abort").length, 0);
    } finally { port1.close(); port2.close(); }
  });
  it("cancels queued and noncooperative active renders independently and recovers the worker slot", async () => {
    setRenderWorkers(1);
    const { port1, port2 } = new MessageChannel();
    const active = new AbortController(); const queued = new AbortController();
    const reason = new Error("Stop active render"); const queuedReason = new Error("Stop queued render");
    const started = once(port1, "message"); const closed = once(port1, "close");
    const rendering = renderComponents('<x-prepared id="subject"></x-prepared>', { definitions: [product, counter], signal: active.signal,
      prepare: { module: preparation, data: { query: "held", wait: true }, port: port2 } });
    const stopped = assert.rejects(rendering, error => error === reason);
    try {
      assert.deepEqual((await started)[0], { event: "start", query: "held" });
      const queuedPorts = new MessageChannel();
      try {
        const queuedClosed = once(queuedPorts.port1, "close");
        const waiting = renderComponents('<x-server-counter></x-server-counter>', { definitions: [counter], signal: queued.signal,
          prepare: { module: preparation, data: { query: "queued" }, port: queuedPorts.port2 } });
        const cancelled = assert.rejects(waiting, error => error === queuedReason);
        queued.abort(queuedReason); await cancelled; await queuedClosed;
      } finally { queuedPorts.port1.close(); queuedPorts.port2.close(); }
      assert.equal(active.signal.aborted, false);
      active.abort(reason); await stopped; await closed;
      isolated(await conflicting(4), 4);
      assert.equal(getEventListeners(active.signal, "abort").length, 0);
      assert.equal(getEventListeners(queued.signal, "abort").length, 0);
      await assert.rejects(renderComponents("", { definitions: [], signal: active.signal }), error => error === reason);
    } finally { active.abort(reason); port1.close(); port2.close(); setRenderWorkers(Math.min(availableParallelism(), 8)); }
  });
  it("closes transferred ports after preparation failure or async cleanup failure and keeps rendering", async () => {
    for (const [data, message] of [[{ fail: true }, "Preparation refused"], [{ cleanupFail: true }, "Cleanup refused"]] as const) {
      const { port1, port2 } = new MessageChannel();
      const closed = once(port1, "close");
      port1.on("message", message => { if (message.event === "read") port1.postMessage("Private result"); });
      try {
        await assert.rejects(renderComponents('<x-prepared id="subject"></x-prepared>', { definitions: [product, counter],
          prepare: { module: preparation, data: { query: "B", ...data }, port: port2 } }), new RegExp(message));
        await closed;
        isolated(await conflicting(4), 4);
      } finally { port1.close(); port2.close(); }
    }
    const { port1, port2 } = new MessageChannel();
    const closed = once(port1, "close");
    try {
      await assert.rejects(renderComponents("", { definitions: [], url: "invalid URL", prepare: { module: preparation, port: port2 } }), /Invalid URL/);
      await closed;
      isolated(await conflicting(4), 4);
    } finally { port1.close(); port2.close(); }
  });
  it("closes active and queued preparations together without dispatching another job during shutdown", async () => {
    setRenderWorkers(1);
    const active = new MessageChannel(); const queued = new MessageChannel();
    const cancel = new AbortController();
    const started = once(active.port1, "message");
    const closed = Promise.all([once(active.port1, "close"), once(queued.port1, "close")]);
    const rendering = renderComponents("", { definitions: [], prepare: { module: preparation, port: active.port2, data: { wait: true } } });
    const stopped = assert.rejects(rendering, /exited without a result/);
    let status = "pending";
    let waiting: Promise<unknown> | undefined;
    try {
      await started;
      waiting = renderComponents("", { definitions: [], signal: cancel.signal,
        prepare: { module: preparation, port: queued.port2, data: { wait: true } } }).then(
        () => { status = "resolved"; }, error => { status = "rejected"; return error; });
      await closeRenderWorkers(); await stopped;
      assert.equal(status, "rejected");
      assert.match(String(await waiting), /exited without a result/);
      await closed;
      assert.equal(getEventListeners(cancel.signal, "abort").length, 0);
      isolated(await conflicting(4), 4);
    } finally {
      cancel.abort(); await waiting; await closeRenderWorkers();
      active.port1.close(); active.port2.close(); queued.port1.close(); queued.port2.close();
      setRenderWorkers(Math.min(availableParallelism(), 8));
    }
  });
  it("rejects invalid preparation modules and non-cloneable input without retaining a worker slot", async () => {
    setRenderWorkers(1);
    try {
      for (const [source, message] of [
        ["export default () => {}", "must export a named prepare function"],
        ["export const prepare = () => 5", "must return cleanup or undefined"],
        ["throw new Error('Module refused')", "Module refused"],
      ]) {
        await assert.rejects(renderComponents("", { definitions: [], prepare: { module: "data:text/javascript," + encodeURIComponent(source!) } }), new RegExp(message!));
        isolated(await conflicting(4), 4);
      }
      for (const aborted of [false, true]) {
        const { port1, port2 } = new MessageChannel();
        const closed = once(port1, "close"); const controller = new AbortController();
        const reason = new Error("Already aborted");
        if (aborted) controller.abort(reason);
        try {
          await assert.rejects(renderComponents("", { definitions: [], signal: controller.signal,
            prepare: { module: preparation, port: port2, data: () => "Not cloneable" } }),
            error => aborted ? error === reason : (error as Error).name === "DataCloneError");
          await closed;
          assert.equal(getEventListeners(controller.signal, "abort").length, 0);
          isolated(await conflicting(4), 4);
        } finally { port1.close(); port2.close(); }
      }
    } finally { setRenderWorkers(Math.min(availableParallelism(), 8)); }
  });
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
