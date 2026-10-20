import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { afterEach, describe, it, vi } from "vitest";
import { BindingScope, type BindingOperation, type BindingProviders, type BindingScopeOptions, type BindingSubscription } from "../src/bindings.js";
import { componentInputs, type ComponentInputs, type InputSource } from "../src/inputs.js";
import { componentRegistry, getComponentHost, lowerDocument, registerComponentDefinitions, serializeRenderedForm } from "../src/runtime.js";
import { parseComponent } from "../src/source-parser.js";

const windows: JSDOM[] = [];
const scopes: BindingScope[] = [];
const definition = '<template component="x-bound" module="./browser-only.js"><defs><prop name="id" type="integer" default="1">Lookup.</prop><prop name="value" type="integer">Value.</prop><prop name="second" type="integer">Dependent.</prop><prop name="third" type="integer">Third.</prop><prop name="fourth" type="integer">Fourth.</prop><prop name="enabled" type="boolean" default="true">Enabled.</prop><prop name="sample" type="string" default="original">Sample.</prop></defs><section><template $await="binding of $value"><output>{$value}</output><small $if="$binding.pending">Refreshing.</small><em $if="$binding.error">{$binding.error.message}</em></template><p $error="problem">{$problem.name}: {$problem.message}</p><i $else>Loading.</i></section></template>';
function fixture(providers: BindingProviders, options: Partial<BindingScopeOptions> = {}, html = "<x-bound></x-bound>", componentSource = definition) {
  const dom = new JSDOM(`<!doctype html><html><head></head><body>${html}</body></html>`, { url: "https://example.test/" });
  windows.push(dom);
  for (const name of ["Node", "Element", "HTMLElement", "Text", "Comment", "HTMLTemplateElement", "HTMLInputElement", "HTMLTextAreaElement", "HTMLSelectElement", "HTMLOptionElement", "HTMLFormElement", "MutationObserver", "Event", "CustomEvent"]) vi.stubGlobal(name, Reflect.get(dom.window, name));
  registerComponentDefinitions([parseComponent(componentSource)], dom.window.document);
  lowerDocument(dom.window.document, { connect: false });
  const root = dom.window.document.querySelector("section")!;
  const port = componentInputs(getComponentHost(root)!);
  const scope = new BindingScope(port, providers, { phase: "request", ...options });
  scopes.push(scope);
  return { dom, root, port, scope, update: (props: Record<string, unknown>) => componentRegistry.update(root, props) };
}
const tick = async () => { for (let index = 0; index < 12; index += 1) await Promise.resolve(); };
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
afterEach(() => {
  for (const scope of scopes.splice(0)) scope.dispose();
  for (const dom of windows.splice(0)) dom.window.close();
  vi.useRealTimers(); vi.unstubAllGlobals();
});

describe("selected input provider scopes", () => {
  it("captures only selected and sampled declarations for a host transfer", async () => {
    let operation!: BindingOperation;
    const source = definition.replace('<prop name="id"', '<state name="opaque" type="unknown"></state><state name="query" type="string" value="search"></state><prop name="id"');
    const { scope, root } = fixture({ value: {
      input: (props, { state }) => ({ id: props.id, query: state.query }), sample: props => props.sample,
      load: (input, context) => { operation = context; context.captureInputs!(); return input.id; },
    } }, {}, "<x-bound></x-bound>", source);
    getComponentHost(root)!.state.opaque = new Map([["ui", "only"]]);
    scope.activate(); await scope.settled();
    const first = operation.captureInputs!();
    assert.deepEqual(first, { props: { id: 1, sample: "original" }, state: { query: "search" } });
    (first.props as Record<string, unknown>).id = 999;
    assert.equal(operation.captureInputs!().props.id, 1);
    assert.equal(operation.captureInputs!(["enabled"]).props.enabled, true);
    assert.equal(operation.captureInputs!(["second"]).props.enabled, true, "augmenting a frame preserves previously captured fields");
  });
  it("preserves host context getters rather than sampling them at construction", async () => {
    let activePort!: ComponentInputs; let contextReads = 0;
    const selected: unknown[] = [];
    const { scope, port, update } = fixture({ second: { input: (_props, context) => (context.route as { id: number }).id,
      load: id => { selected.push(id); return id; } } }, { context: { get route() { contextReads += 1; return { id: activePort.read("id") }; } } });
    activePort = port;
    assert.equal(contextReads, 0, "constructing a passive scope must not evaluate tracked context");
    scope.activate(); await scope.settled();
    assert.deepEqual(selected, [1]);
    update({ id: 2 }); await tick(); await scope.settled();
    assert.deepEqual(selected, [1, 2]);
    assert.equal(port.read("second"), 2);
  });

  it("does not pass an unavailable declaration value through a typed selector", async () => {
    let afterRead = 0;
    const { scope, port } = fixture({ second: { input: props => { const value = props.value; afterRead += 1; return value; }, load: value => value + 1 } });
    scope.activate(); await scope.settled();
    assert.equal(afterRead, 0);
    assert.equal(port.status("second").ready, false);
    const source = port.source("value");
    source.publish({ value: 10, status: { ready: true, pending: false, stale: false, error: null } });
    await tick(); await scope.settled();
    assert.ok(afterRead > 0);
    assert.equal(port.read("second"), 11);
    source.dispose();
  });

  it("reports an unavailable sample without silently making it a watched prerequisite", async () => {
    let loads = 0;
    const { scope, port } = fixture({ second: { input: props => props.id, sample: props => props.value,
      load: () => { loads += 1; return 20; } } });
    scope.activate(); await scope.settled();
    assert.equal(loads, 0);
    assert.equal(port.status("second").error?.name, "InputUnavailableError");
    const source = port.source("value");
    source.publish({ value: 10, status: { ready: true, pending: false, stale: false, error: null } });
    await tick();
    assert.equal(loads, 0, "a sampled field does not trigger reads");
    await scope.refresh("second");
    assert.equal(loads, 1);
    source.dispose();
  });

  for (const fails of [false, true]) it(`refuses an obsolete ${fails ? "failure" : "result"} before queued observer cleanup`, async () => {
    const { port, update } = fixture({});
    const first = deferred<number>(); const second = deferred<number>();
    const published: unknown[] = [];
    const observed: ComponentInputs = { ...port, source<T>(name: string): InputSource<T> {
      const source = port.source<T>(name);
      return { ...source, publish(snapshot) {
        if (snapshot.status.ready) published.push(snapshot.value);
        if (snapshot.status.error !== null) published.push(snapshot.status.error.message);
        return source.publish(snapshot);
      } };
    } };
    const scope = new BindingScope(observed, { value: { input: props => props.id, load: id => id === 1 ? first.promise : second.promise } }, { phase: "request" });
    scopes.push(scope);
    scope.activate(); await tick();
    if (fails) first.reject(new Error("Obsolete failure")); else first.resolve(10);
    update({ id: 2 });
    await tick(); second.resolve(20); await scope.settled();
    assert.deepEqual(published, [20]);
  });

  it("preserves a still-refreshing prerequisite's activity after a dependent read completes", async () => {
    let reads = 0;
    const { scope, port } = fixture({ second: { input: props => props.value, load: value => { reads += 1; return value + 1; } } });
    const upstream = port.source("value");
    try {
      upstream.publish({ value: 10, status: { ready: true, pending: true, stale: false, error: null } });
      scope.activate(); await scope.settled();
      assert.equal(port.read("second"), 11);
      assert.equal(port.status("second").pending, true);
      upstream.publish({ value: 10, status: { ready: true, pending: false, stale: false, error: { name: "Error", message: "Upstream failed" } } });
      await tick(); await scope.settled();
      assert.equal(port.status("second").error?.message, "Upstream failed");
      assert.equal(reads, 1);
    } finally { upstream.dispose(); }
  });

  it("reports subscription-selector failures without blocking the independent initial read", async () => {
    let reads = 0; let opened = 0;
    const { scope, port, update } = fixture({ value: { input: props => props.id, load: id => { reads += 1; return id * 10; }, subscribe: {
      input: props => { if (props.enabled) throw new Error("Bad stream selector"); return props.id; },
      open: () => { opened += 1; },
    } } }, { phase: "browser" });
    scope.activate(); await scope.settled();
    assert.equal(port.read("value"), 10);
    assert.equal(port.status("value").error?.message, "Bad stream selector");
    assert.equal(opened, 0);
    update({ enabled: false }); await tick(); await scope.settled();
    assert.equal(port.status("value").error, null);
    assert.deepEqual([reads, opened], [1, 1]);
  });

  it("refuses stream publications immediately after selected inputs change or become stale", async () => {
    const publishers: BindingSubscription[] = []; let closed = 0;
    const { scope, port } = fixture({ value: { input: () => null, subscribe: {
      input: props => props.id, open: (_id, operation) => { publishers.push(operation); return () => { closed += 1; }; },
    } } }, { phase: "browser" });
    const upstream = port.source("id");
    try {
      scope.activate(); await tick();
      upstream.publish({ value: 2, status: { ready: true, pending: false, stale: false, error: null } });
      assert.equal(publishers[0]!.publish(11), false, "the observer's queued cleanup is not the publication guard");
      await tick();
      assert.equal(publishers[1]!.publish(22), true);
      upstream.publish({ value: 2, status: { ready: true, pending: true, stale: true, error: null } });
      assert.equal(publishers[1]!.publish(23), false);
      await tick();
      assert.equal(closed, 2);
      upstream.publish({ value: 3, status: { ready: true, pending: false, stale: false, error: null } });
      await tick();
      assert.equal(publishers[2]!.publish(33), true);
      assert.equal(port.read("value"), 33);
    } finally { upstream.dispose(); }
  });

  it("resumes polling after a stale prerequisite becomes current without an immediate duplicate read", async () => {
    vi.useFakeTimers(); let reads = 0;
    const { scope, port } = fixture({ second: { input: props => props.value, poll: 10, load: value => { reads += 1; return value; } } }, { phase: "browser" });
    const upstream = port.source("value");
    try {
      upstream.publish({ value: 10, status: { ready: true, pending: false, stale: false, error: null } });
      scope.activate(); await scope.settled();
      upstream.publish({ value: 10, status: { ready: true, pending: true, stale: true, error: null } }); await tick();
      await vi.advanceTimersByTimeAsync(50);
      assert.equal(reads, 1);
      upstream.publish({ value: 10, status: { ready: true, pending: false, stale: false, error: null } }); await tick(); await scope.settled();
      assert.equal(reads, 1);
      await vi.advanceTimersByTimeAsync(10); await scope.settled();
      assert.equal(reads, 2);
    } finally { upstream.dispose(); }
  });

  for (const keepPrevious of [false, true]) it(`waits for a fresh prerequisite before reading a new selection with keepPrevious=${keepPrevious}`, async () => {
    const reads: [number, number][] = [];
    const { scope, port, update } = fixture({ second: { keepPrevious, input: props => [props.value, props.id],
      load: ([value, id]) => { reads.push([value, id]); return value + id; } } });
    const upstream = port.source("value");
    try {
      upstream.publish({ value: 10, status: { ready: true, pending: true, stale: true, error: null } });
      scope.activate(); await scope.settled();
      assert.deepEqual(reads, []);
      assert.equal(port.status("second").ready, false);
      upstream.publish({ value: 20, status: { ready: true, pending: false, stale: false, error: null } });
      await tick(); await scope.settled();
      assert.equal(port.read("second"), 21);
      upstream.publish({ value: 20, status: { ready: true, pending: true, stale: true, error: null } });
      await tick();
      assert.equal(port.status("second").stale, true, "the current selected result can remain visible");
      upstream.publish({ value: 20, status: { ready: true, pending: false, stale: false, error: null } });
      await tick(); await scope.settled();
      assert.deepEqual(reads, [[20, 1]], "a fresh prerequisite with the same selected value does not repeat the read");
      upstream.publish({ value: 20, status: { ready: true, pending: true, stale: true, error: null } });
      await tick();
      update({ id: 2 }); await tick(); await scope.settled();
      assert.equal(port.status("second").ready, keepPrevious);
      assert.deepEqual(reads, [[20, 1]], "a new filter cannot request against the old prerequisite");
      upstream.publish({ value: 30, status: { ready: true, pending: false, stale: false, error: null } });
      await tick(); await scope.settled();
      assert.deepEqual(reads, [[20, 1], [30, 2]]);
      assert.equal(port.read("second"), 32);
    } finally { upstream.dispose(); }
  });

  it("adopts retained data while a prerequisite is stale without starting a stale read", async () => {
    let reads = 0;
    const providers: BindingProviders = { second: { input: props => props.value, load: value => { reads += 1; return value + 1; } } };
    const server = fixture(providers, { source: "build-a" });
    const upstream = server.port.source("value");
    upstream.publish({ value: 10, status: { ready: true, pending: false, stale: false, error: null } });
    server.scope.activate(); await server.scope.settled();
    upstream.publish({ value: 10, status: { ready: true, pending: true, stale: true, error: null } });
    await tick();
    const snapshot = server.scope.snapshot(); const html = serializeRenderedForm(server.dom.window.document.body);
    server.scope.dispose(); upstream.dispose();
    const client = fixture(providers, { source: "build-a", snapshot, phase: "browser" }, html);
    client.scope.activate(); await client.scope.settled();
    assert.equal(reads, 1);
    assert.equal(client.port.read("second"), 11);
    assert.equal(client.port.status("second").stale, true);
    const current = client.port.source("value");
    current.publish({ value: 20, status: { ready: true, pending: false, stale: false, error: null } });
    await tick(); await client.scope.settled();
    assert.equal(client.port.read("second"), 21);
    assert.equal(reads, 2);
    current.dispose();
  });

  it("selects declared state and computeds with actual prerequisite availability and retained refresh status", async () => {
    const first = deferred<number>(); const refresh = deferred<number>();
    let reads = 0; const derived: number[] = [];
    const { scope, port, root, update } = fixture({
      value: { input: props => props.id, load: () => ++reads === 1 ? first.promise : refresh.promise },
      second: { input: (_props, { state }) => state.selected, load: value => { derived.push(value); return value + 1; } },
    }, {}, "<x-bound></x-bound>", definition.replace("</defs>", '<state name="query" type="integer" value="5"></state><computed name="selected" type="integer" from="$enabled ? $value : $query"></computed></defs>'));
    const host = getComponentHost(root)!;
    assert.ok(port.readNames.includes("query")); assert.ok(port.readNames.includes("selected"));
    assert.equal(port.names.includes("query"), false);
    assert.throws(() => port.source("query"), /not a declared prop/);
    assert.throws(() => port.revision("selected"), /not a declared prop/);
    assert.throws(() => port.read("unknown"), /not declared/);
    scope.activate(); await tick();
    assert.deepEqual(derived, []);
    assert.deepEqual(port.status("second"), { ready: false, pending: true, error: null, stale: false });
    host.state.query = 20; await tick();
    assert.deepEqual(derived, [], "an unused branch cannot start the dependent read");
    update({ enabled: false }); await tick();
    assert.equal(port.read("second"), 21);
    first.resolve(10); await scope.settled();
    assert.deepEqual(derived, [20]);
    host.state.query = 30; await tick(); await scope.settled();
    assert.equal(port.read("second"), 31);
    update({ enabled: true }); await tick(); await scope.settled();
    assert.equal(port.read("second"), 11);
    const refreshing = scope.refresh("value"); await tick();
    assert.equal(port.status("second").pending, true);
    assert.equal(port.read("second"), 11);
    refresh.reject(new Error("Refresh failed")); await refreshing;
    assert.equal(port.status("second").error?.message, "Refresh failed");
    assert.deepEqual(derived, [20, 30, 10]);
  });

  it("adopts prepared read identities without duplicating work or losing a handled initial failure", async () => {
    for (const failed of [false, true]) {
      let reads = 0;
      const providers: BindingProviders = { value: { input: props => props.id, load: id => {
        reads += 1; if (failed) throw new Error("Offline"); return id * 10;
      } } };
      const server = fixture(providers, { source: "build-a" });
      server.scope.activate(); await server.scope.settled();
      const snapshot = server.scope.snapshot();
      const html = serializeRenderedForm(server.dom.window.document.body);
      server.scope.deactivate();
      assert.deepEqual(server.scope.snapshot(), snapshot, "ending active work does not erase the retained read identity");
      const client = fixture(providers, { source: "build-a", snapshot, phase: "browser" }, html);
      assert.equal(client.port.revision("value"), snapshot.reads.value!.revision);
      client.scope.activate(); await client.scope.settled();
      assert.equal(reads, 1);
      assert.equal(client.port.status("value").ready, !failed);
      assert.equal(client.port.status("value").error?.message, failed ? "Offline" : undefined);
      await client.scope.refresh("value");
      assert.equal(reads, 2, "an explicit refresh retries a prepared failure too");
    }
  });

  it("transfers the attempted and retained inputs separately after a failed changed-input read", async () => {
    let reads = 0;
    const providers: BindingProviders = { value: { input: props => props.id, keepPrevious: true, load: id => {
      reads += 1; if (id === 2) throw new Error("Second failed"); return id * 10;
    } } };
    const server = fixture(providers, { source: "build-a" });
    server.scope.activate(); await server.scope.settled();
    server.update({ id: 2 }); await tick(); await server.scope.settled();
    const snapshot = server.scope.snapshot();
    assert.notEqual(snapshot.reads.value!.input, snapshot.reads.value!.value);
    const html = serializeRenderedForm(server.dom.window.document.body);
    server.scope.deactivate();
    const client = fixture(providers, { source: "build-a", snapshot, phase: "browser" }, html);
    client.scope.activate(); await client.scope.settled();
    assert.equal(reads, 2);
    assert.equal(client.port.read("value"), 10);
    assert.equal(client.port.status("value").stale, true);
    assert.equal(client.port.status("value").error?.message, "Second failed");
    client.update({ id: 3 }); await tick(); await client.scope.settled();
    assert.equal(client.port.read("value"), 30);
    assert.equal(reads, 3);
  });

  it("does not promote a prerequisite failure into the adopted read's own failure", async () => {
    let reads = 0;
    const providers: BindingProviders = { value: { input: props => props.id, load: id => { reads += 1; return id; } } };
    const server = fixture(providers, { source: "build-a" });
    server.scope.activate(); await server.scope.settled();
    server.port.source("id").publish({ value: 1, status: { ready: true, pending: false, stale: false, error: { name: "Error", message: "Upstream" } } });
    await tick();
    const snapshot = server.scope.snapshot();
    assert.equal(snapshot.reads.value!.error, undefined);
    const html = serializeRenderedForm(server.dom.window.document.body);
    server.scope.deactivate();
    const client = fixture(providers, { source: "build-a", snapshot, phase: "browser" }, html);
    client.scope.activate(); await client.scope.settled();
    assert.equal(client.port.status("value").error?.message, "Upstream");
    client.port.source("id").publish({ value: 1, status: { ready: true, pending: false, stale: false, error: null } });
    await tick(); await client.scope.settled();
    assert.equal(client.port.status("value").error, null);
    assert.equal(reads, 1);
  });

  it("invalidates transferred reads for a changed module, changed input, or intervening accepted fixture", async () => {
    for (const change of ["module", "input", "fixture", "revalidate"] as const) {
      let reads = 0;
      const providers: BindingProviders = { value: { input: props => props.id, load: id => { reads += 1; return id * 10; },
        ...(change === "revalidate" ? { revalidate: "activate" } : {}) } };
      const server = fixture(providers, { source: "build-a" });
      server.scope.activate(); await server.scope.settled();
      const snapshot = server.scope.snapshot();
      const html = serializeRenderedForm(server.dom.window.document.body);
      server.scope.deactivate();
      const client = fixture(providers, { source: change === "module" ? "build-b" : "build-a", snapshot, phase: "browser" }, html);
      if (change === "input") client.update({ id: 2 });
      if (change === "fixture") { client.update({ value: 99 }); client.update({ value: undefined }); }
      client.scope.activate(); await client.scope.settled();
      assert.equal(reads, 2, change);
      assert.equal(client.port.read("value"), change === "input" ? 20 : 10);
    }
  });

  it("copies snapshot error records and refuses malformed completion identities", async () => {
    const server = fixture({ value: { input: props => props.id, load: () => { throw new Error("Original"); } } }, { source: "build-a" });
    server.scope.activate(); await server.scope.settled();
    const snapshot = server.scope.snapshot();
    (snapshot.reads.value!.error as { message: string }).message = "Edited snapshot";
    assert.equal(server.port.status("value").error?.message, "Original");
    assert.throws(() => new BindingScope(server.port, { value: { input: () => 1, load: () => 1 } }, {
      phase: "browser", source: "build-a", snapshot: { source: "build-a", reads: { value: { input: "1", revision: -1 } } },
    }), /Malformed prepared binding/);
  });

  it("prepares a dependency declared before its producer without running browser behavior", async () => {
    const calls: unknown[] = [];
    const { scope, port, root, dom } = fixture({
      second: { input: props => props.value, load: value => { calls.push(["second", value]); return value + 1; } },
      value: { input: props => props.id, load: (id, context) => { calls.push([context.phase, id]); return id * 10; } },
    });
    scope.activate();
    await scope.settled();
    assert.deepEqual(calls, [["request", 1], ["second", 10]]);
    assert.equal(port.read("value"), 10);
    assert.equal(port.read("second"), 11);
    assert.equal(port.supplied("value"), false);
    assert.equal(root.querySelector("output")?.textContent, "10");
    assert.match(serializeRenderedForm(dom.window.document.body), /10<\/output>/);
  });

  it("bypasses selectors, reads and subscriptions for fixtures and restarts after release", async () => {
    let selected = 0; let reads = 0; let opened = 0;
    const { scope, port, update } = fixture({ value: {
      input: props => { selected += 1; return props.id; },
      load: id => { reads += 1; return id; },
      subscribe: () => { opened += 1; },
    } }, { phase: "browser" });
    update({ value: 0 });
    scope.activate(); await scope.settled();
    assert.deepEqual([selected, reads, opened], [0, 0, 0]);
    assert.equal(port.read("value"), 0);
    update({ value: null }); await tick();
    assert.equal(port.read("value"), null);
    assert.deepEqual([selected, reads, opened], [0, 0, 0]);
    update({ value: undefined }); await tick(); await scope.settled();
    assert.equal(reads, 1);
    assert.equal(opened, 1);
    assert.equal(port.read("value"), 1);
  });

  it("ignores an obsolete request that never cooperates with cancellation", async () => {
    const requests: { id: number; operation: BindingOperation; result: ReturnType<typeof deferred<number>> }[] = [];
    const { scope, port, update } = fixture({ value: { input: props => props.id, load: (id, operation) => {
      const result = deferred<number>(); requests.push({ id, operation, result }); return result.promise;
    } } });
    scope.activate(); await tick();
    update({ id: 2 }); await tick();
    assert.deepEqual(requests.map(request => request.id), [1, 2]);
    assert.equal(requests[0]!.operation.signal.aborted, true);
    requests[1]!.result.resolve(20);
    await scope.settled();
    assert.equal(port.read("value"), 20);
    requests[0]!.result.resolve(999); await tick();
    assert.equal(port.read("value"), 20);
  });

  it("retains same-input refresh data and exposes failures until an explicit retry", async () => {
    let read = 0;
    const refresh = deferred<number>();
    const { scope, root, port } = fixture({ value: { input: props => props.id, load: () => ++read === 1 ? 7 : read === 2 ? refresh.promise : 8 } });
    scope.activate(); await scope.settled();
    const output = root.querySelector("output");
    const pending = scope.refresh("value"); await tick();
    assert.equal(root.querySelector("output"), output);
    assert.equal(root.querySelector("small")?.textContent, "Refreshing.");
    refresh.reject(new Error("Offline")); await pending; await tick();
    assert.equal(port.read("value"), 7);
    assert.equal(root.querySelector("em")?.textContent, "Offline");
    assert.equal(root.querySelector("p"), null);
    assert.equal(read, 2);
    await scope.refresh("value"); await tick();
    assert.equal(port.read("value"), 8);
    assert.equal(root.querySelector("em"), null);
  });

  for (const keepPrevious of [false, true]) it(`handles changed input with keepPrevious=${keepPrevious}`, async () => {
    const next = deferred<number>();
    const { scope, port, update } = fixture({ value: { input: props => props.id, keepPrevious,
      load: id => id === 1 ? 10 : next.promise } });
    scope.activate(); await scope.settled();
    update({ id: 2 }); await tick();
    assert.equal(port.status("value").ready, keepPrevious);
    assert.equal(port.status("value").stale, keepPrevious);
    next.resolve(20); await scope.settled();
    assert.equal(port.read("value"), 20);
    assert.equal(port.status("value").stale, false);
  });

  it("tracks only the evaluated conditional prerequisite and recovers from a cycle through a fixture", async () => {
    const { scope, port, update } = fixture({
      value: { input: props => props.enabled ? props.second : props.id, load: value => value + 1 },
      second: { input: props => props.value, load: value => value + 1 },
    });
    scope.activate(); await scope.settled();
    assert.equal(port.status("value").error?.name, "BindingCycleError");
    assert.equal(port.status("second").error?.name, "BindingCycleError");
    update({ value: 7 }); await tick(); await scope.settled();
    assert.equal(port.read("second"), 8);
    update({ value: undefined, enabled: false }); await tick(); await scope.settled();
    assert.equal(port.read("value"), 2);
    assert.equal(port.read("second"), 3);
    assert.equal(port.status("value").error, null);
  });

  it("reports independent cycles and dependencies read by unresolved enable predicates", async () => {
    const { scope, port } = fixture({
      value: { when: props => props.second !== null, input: props => props.id, load: value => value },
      second: { when: props => props.value !== null, input: props => props.id, load: value => value },
      third: { input: props => props.fourth, load: value => value },
      fourth: { input: props => props.third, load: value => value },
    });
    scope.activate(); await scope.settled();
    for (const name of ["value", "second", "third", "fourth"]) assert.equal(port.status(name).error?.name, "BindingCycleError", name);
  });

  it("rejects unknown outputs and contradictory timer policies", () => {
    assert.throws(() => fixture({ missing: { input: () => 1, load: value => value } }), /not a declared prop/);
    assert.throws(() => fixture({ value: { input: () => 1, load: value => value, initial: "manual", poll: "10ms" } }), /cannot also poll/);
    assert.throws(() => fixture({ value: { input: () => 1, load: value => value, timeout: -1 } }), /nonnegative time/);
  });

  it("applies manual/browser policies without starting browser work during preparation", async () => {
    let loads = 0; let streams = 0;
    const { scope, port } = fixture({
      value: { input: props => props.id, initial: "manual", load: () => ++loads },
      second: { input: props => props.id, initial: "browser", load: () => ++loads, subscribe: () => { streams += 1; } },
    }, { phase: "build" });
    scope.activate(); await scope.settled();
    assert.equal(loads, 0); assert.equal(streams, 0);
    assert.equal(port.status("value").ready, false);
    await scope.refresh("value");
    assert.equal(loads, 1);
    assert.equal(port.read("value"), 1);
    assert.equal(port.status("second").ready, false);
  });

  it("samples at send time without making sampled changes trigger reads", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const calls: unknown[] = [];
    const { scope, update } = fixture({ value: { input: props => props.id, debounce: "50ms", sample: props => props.sample,
      load: (id, operation) => { calls.push([id, operation.sample]); return id; } } }, { phase: "browser" });
    scope.activate(); await tick();
    update({ id: 2 }); await tick();
    update({ sample: "at send" }); await tick();
    await vi.advanceTimersByTimeAsync(50); await scope.settled();
    assert.deepEqual(calls, [[2, "at send"]]);
    update({ sample: "later" }); await tick();
    await vi.advanceTimersByTimeAsync(100);
    assert.deepEqual(calls, [[2, "at send"]]);
  });

  it("times out a non-cooperating read and cancels preparation on root abort", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { scope, port } = fixture({ value: { input: props => props.id, timeout: 10, load: () => new Promise<number>(() => {}) } });
    scope.activate(); await tick();
    await vi.advanceTimersByTimeAsync(10); await scope.settled();
    assert.equal(port.status("value").error?.name, "TimeoutError");
    const aborted = new AbortController();
    const other = fixture({ value: { input: props => props.id, load: () => new Promise<number>(() => {}) } }, { signal: aborted.signal });
    other.scope.activate(); await tick();
    const pending = other.scope.settled();
    aborted.abort();
    await assert.rejects(pending, { name: "AbortError" });
  });

  it("opens subscriptions only after the initial read and refuses stale publishers", async () => {
    const first = deferred<number>();
    const setup = deferred<void | (() => void)>();
    let stopped = 0; let stream: BindingSubscription | undefined;
    const { scope, port, update } = fixture({ value: { input: props => props.id, load: id => id === 1 ? first.promise : 20,
      subscribe: (_id, operation) => { stream = operation; return setup.promise; } } }, { phase: "browser" });
    scope.activate(); await tick(); assert.equal(stream, undefined);
    first.resolve(10); await scope.settled();
    const previous = stream!;
    assert.equal(previous.publish(11), true);
    update({ value: 99 }); await tick();
    assert.equal(previous.signal.aborted, true);
    assert.equal(previous.publish(12), false);
    setup.resolve(() => { stopped += 1; }); await tick();
    assert.equal(stopped, 1);
    assert.equal(port.read("value"), 99);
  });

  it("retains valid data on reconnection and releases all capabilities on disposal", async () => {
    let loads = 0; let stops = 0;
    const { scope, port } = fixture({ value: { input: props => props.id, load: () => ++loads,
      subscribe: () => () => { stops += 1; } } }, { phase: "browser" });
    scope.activate(); await scope.settled(); scope.deactivate();
    assert.equal(stops, 1);
    scope.activate(); await scope.settled();
    assert.equal(loads, 1);
    assert.equal(port.read("value"), 1);
    scope.dispose();
    assert.equal(stops, 2);
    assert.doesNotThrow(() => port.source("value").dispose());
    assert.throws(() => scope.activate(), /disposed/);
  });

  it("does not reuse producer data replaced by a fixture while detached", async () => {
    let loads = 0;
    const { scope, port, update } = fixture({ value: { input: props => props.id, load: () => ++loads * 10 } });
    scope.activate(); await scope.settled(); scope.deactivate();
    update({ value: 99 }); update({ value: undefined });
    assert.equal(port.read("value"), null);
    scope.activate(); await scope.settled();
    assert.equal(port.read("value"), 20);
    assert.equal(loads, 2);
  });

  it("resumes an interrupted read after retained deactivation", async () => {
    let loads = 0;
    const { scope, port } = fixture({ value: { input: props => props.id, load: () => ++loads === 1 ? new Promise<number>(() => {}) : 20 } });
    scope.activate(); await tick(); scope.deactivate();
    scope.activate(); await scope.settled();
    assert.equal(port.read("value"), 20);
    assert.equal(loads, 2);
  });

  it("does not turn an interrupted manual read into a request for a different input", async () => {
    const requested: unknown[] = [];
    const { scope, port, update } = fixture({ value: { input: props => props.id, initial: "manual", load: id => {
      requested.push(id); return id === 1 ? new Promise<number>(() => {}) : 20;
    } } });
    scope.activate(); await scope.settled();
    const first = scope.refresh("value"); await tick();
    scope.deactivate(); await first;
    update({ id: 2 });
    scope.activate(); await scope.settled();
    assert.deepEqual(requested, [1]);
    assert.equal(port.status("value").ready, false);
    await scope.refresh("value");
    assert.deepEqual(requested, [1, 2]);
    assert.equal(port.read("value"), 20);
  });

  it("keeps stream-only manual sources stopped until refresh and restarts for a new input", async () => {
    const opened: BindingSubscription[] = [];
    const { scope, port, update } = fixture({ value: { input: props => props.id, initial: "manual",
      subscribe: (_id, operation) => { opened.push(operation); } } }, { phase: "browser" });
    scope.activate(); await scope.settled();
    assert.equal(opened.length, 0);
    await scope.refresh("value");
    assert.equal(opened.length, 1);
    assert.equal(port.status("value").pending, true);
    opened[0]!.publish(8); await tick();
    assert.equal(port.read("value"), 8);
    update({ id: 2 }); await tick();
    assert.equal(opened[0]!.signal.aborted, true);
    assert.equal(opened.length, 1);
    assert.equal(port.status("value").ready, false);
    await scope.refresh("value");
    assert.equal(opened.length, 2);
    assert.equal(opened[0]!.publish(99), false);
    opened[1]!.publish(9);
    assert.equal(port.read("value"), 9);
  });

  it("restarts a distinct subscription input without repeating the initial read", async () => {
    let loads = 0; let closed = 0;
    const topics: unknown[] = [];
    const opened: BindingSubscription[] = [];
    const { scope, port, update } = fixture({ value: { input: props => props.id, load: () => ++loads,
      subscribe: { input: props => props.sample, open: (topic, operation) => {
        topics.push(topic); opened.push(operation); return () => { closed += 1; };
      } } } }, { phase: "browser" });
    scope.activate(); await scope.settled();
    update({ sample: "next" }); await tick();
    assert.deepEqual(topics, ["original", "next"]);
    assert.equal(loads, 1); assert.equal(closed, 1);
    assert.equal(opened[0]!.publish(8), false);
    assert.equal(opened[1]!.publish(9), true);
    assert.equal(port.read("value"), 9);
  });

  it("polls after each read settles, prevents overlap, and stops timers on detach", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let loads = 0;
    const pending = deferred<number>();
    const { scope } = fixture({ value: { input: props => props.id, poll: "20ms", load: () => ++loads === 2 ? pending.promise : loads } }, { phase: "browser" });
    scope.activate(); await scope.settled();
    await vi.advanceTimersByTimeAsync(20);
    assert.equal(loads, 2);
    await vi.advanceTimersByTimeAsync(100);
    assert.equal(loads, 2);
    pending.resolve(2); await scope.settled();
    await vi.advanceTimersByTimeAsync(20);
    assert.equal(loads, 3);
    scope.deactivate();
    await vi.advanceTimersByTimeAsync(100);
    assert.equal(loads, 3);
  });

  it("refuses malformed outputs without overwriting the accepted value", async () => {
    let read = 0;
    const { scope, port, update } = fixture({ value: { input: props => props.id, load: () => ++read === 1 ? 7 : "wrong" } });
    scope.activate(); await scope.settled();
    await scope.refresh("value");
    assert.equal(port.read("value"), 7);
    assert.equal(port.status("value").error?.name, "TypeError");
    update({ sample: "unrelated" }); await tick();
    assert.equal(read, 2);
    assert.equal(port.read("value"), 7);
  });

  it("gives each read/stream its own selected data copy without freezing it", async () => {
    const seen: unknown[] = [];
    const { scope } = fixture({ value: { input: props => ({ id: props.id }), load: input => {
      assert.equal(Object.isFrozen(input), false); input.id = 99; return 1;
    }, subscribe: input => { seen.push(input.id); } } }, { phase: "browser" });
    scope.activate(); await scope.settled();
    assert.deepEqual(seen, [1]);
  });

  it("rejects async selectors and reading a retained props view after load awaits", async () => {
    let retained: any;
    const { scope, port } = fixture({
      value: { input: async props => props.id, load: id => id },
      second: { input: props => { retained = props; return props.id; }, load: async () => {
        await Promise.resolve(); return retained.id;
      } },
    });
    scope.activate(); await scope.settled();
    assert.match(port.status("value").error!.message, /selector must return synchronously/);
    assert.match(port.status("second").error!.message, /load receives its captured input/);
  });

  it("bypasses debounce for explicit refresh and treats timeout zero as disabled", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const result = deferred<number>();
    let reads = 0;
    const { scope, port } = fixture({ value: { input: props => props.id, initial: "manual", debounce: "1s", timeout: 0,
      load: () => { reads += 1; return result.promise; } } }, { phase: "browser" });
    scope.activate(); await scope.settled();
    const refreshed = scope.refresh("value"); await tick();
    assert.equal(reads, 1);
    await vi.advanceTimersByTimeAsync(100);
    assert.equal(port.status("value").error, null);
    result.resolve(8); await refreshed;
    assert.equal(port.read("value"), 8);
  });
});
