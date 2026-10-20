import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { afterEach, describe, it, vi } from "vitest";
import { bindModule, type BindingConnection, type BindingModule, type BindingPreparation } from "../src/bindings.js";
import { componentInputs } from "../src/inputs.js";
import { activateModule } from "../src/module-connection.js";
import { componentRegistry, getComponentHost, lowerDocument, registerComponentDefinitions } from "../src/runtime.js";
import { parseComponent } from "../src/source-parser.js";

const windows: JSDOM[] = [];
const releases: (() => void)[] = [];
const source = '<template component="x-module"><defs><prop name="id" type="integer" default="1">Id.</prop><prop name="value" type="integer">Value.</prop><prop name="second" type="integer">Second.</prop></defs><section><b $await="$value">{$value}</b><p $error="problem">{$problem.message}</p><i $else>Loading.</i></section></template>';
function fixture() {
  const dom = new JSDOM("<!doctype html><html><head></head><body><x-module></x-module></body></html>");
  windows.push(dom);
  for (const name of ["Node", "Element", "HTMLElement", "Text", "Comment", "HTMLTemplateElement", "HTMLInputElement", "HTMLTextAreaElement", "HTMLSelectElement", "HTMLOptionElement", "HTMLFormElement", "MutationObserver", "Event", "CustomEvent"]) vi.stubGlobal(name, Reflect.get(dom.window, name));
  registerComponentDefinitions([parseComponent(source)], dom.window.document);
  lowerDocument(dom.window.document, { connect: false });
  const root = dom.window.document.querySelector("section")!;
  const host = getComponentHost(root)!;
  return { host, root, port: componentInputs(host) };
}
const tick = async () => { for (let index = 0; index < 20; index += 1) await Promise.resolve(); };
afterEach(() => {
  for (const release of releases.splice(0)) release();
  for (const dom of windows.splice(0)) dom.window.close();
  vi.unstubAllGlobals();
});

describe("binding module adapter", () => {
  it("runs behavior-only modules without requiring an unused typed-input renderer adapter", async () => {
    const host = { props: {}, state: { count: 0 } };
    let creates = 0; let stops = 0;
    const adapter = bindModule<typeof host>({ create: () => {
      creates += 1;
      return { connect: (current, { signal, refresh }) => {
        current.state.count += 1;
        assert.equal(signal.aborted, false);
        void refresh("anything");
        return () => { stops += 1; };
      } };
    } });
    const prepared = await adapter.prepare(host, { phase: "request", source: "build-a" });
    assert.deepEqual(prepared.names, []);
    assert.deepEqual(prepared.snapshot(), { source: "build-a", reads: {} });
    prepared.dispose();
    assert.equal(host.state.count, 0);
    const first = activateModule(adapter, host); first();
    const second = activateModule(adapter, host); second();
    assert.deepEqual([creates, host.state.count, stops], [1, 2, 2]);
    const cancellation = new AbortController(); cancellation.abort();
    await assert.rejects(adapter.prepare(host, { phase: "request", signal: cancellation.signal }), { name: "AbortError" });
  });

  it("creates once per logical instance and retains passive data across fresh browser activations", async () => {
    const first = fixture(); const second = fixture();
    let creates = 0; let reads = 0; let connects = 0; let cleanups = 0;
    const signals: AbortSignal[] = [];
    const adapter = bindModule({ create: () => {
      creates += 1;
      return { props: { value: { input: props => props.id, load: id => { reads += 1; return id * 10; } } },
        connect: (_host, { signal }) => { connects += 1; signals.push(signal); return () => { cleanups += 1; }; } };
    } });
    const errors: unknown[] = [];
    const stop = activateModule(adapter, first.host, error => errors.push(error));
    await tick();
    assert.equal(first.port.read("value"), 10);
    stop(); stop();
    const again = activateModule(adapter, first.host, error => errors.push(error)); releases.push(again);
    const other = activateModule(adapter, second.host, error => errors.push(error)); releases.push(other);
    await tick();
    assert.deepEqual([creates, reads, connects, cleanups], [2, 2, 3, 1]);
    assert.equal(signals[0]!.aborted, true);
    assert.equal(signals[1]!.aborted, false);
    assert.notEqual(signals[0], signals[1]);
    assert.deepEqual(errors, []);
  });

  it("prepares providers without browser behavior and keeps factory state scoped to the instance", async () => {
    const { host, port } = fixture(); let creates = 0;
    const adapter = bindModule({ create: () => {
      creates += 1; let reads = 0;
      return { props: { value: { input: props => props.id, load: () => ++reads }, second: false as const }, connect: () => { throw new Error("Browser only"); } };
    } });
    const scope = await adapter.prepare(host, { phase: "request", source: "build-a" });
    try { assert.equal(port.read("value"), 1); assert.equal(scope.snapshot().source, "build-a"); assert.deepEqual(scope.names, ["value"]); }
    finally { scope.dispose(); }
    const next = await adapter.prepare(host, { phase: "build" }); releases.push(() => next.dispose());
    assert.equal(port.read("value"), 2);
    assert.equal(creates, 1);
  });

  it("replaces only named providers and supports disabling while keeping component interactions", async () => {
    const { host, port } = fixture(); let connected = 0;
    const adapter = bindModule({ props: {
      value: { input: props => props.id, load: () => { throw new Error("Replaced"); } },
      second: { input: props => props.value, load: value => value + 1 },
    }, connect: () => { connected += 1; } }, { overrides: { value: { input: () => 0, load: () => 42 } } });
    releases.push(activateModule(adapter, host)); await tick();
    assert.equal(port.read("second"), 43);
    assert.equal(connected, 1);
    releases.pop()!();
    const disabled = bindModule({ props: { value: { input: () => 1, load: () => { throw new Error("Disabled"); } } } }, { overrides: { value: false } });
    releases.push(activateModule(disabled, host)); await tick();
    componentRegistry.update(host.root, { value: 9 });
    assert.equal(port.read("value"), 9);
  });

  it("runs browser interactions while data is pending, and rejects stale refresh commands", async () => {
    const { host, port } = fixture(); let context: BindingConnection | undefined; let reads = 0;
    const adapter = bindModule({ props: { value: { input: () => 1, load: () => { reads += 1; return new Promise<number>(() => {}); } } },
      connect: (_host, current) => { context = current; } });
    const stop = activateModule(adapter, host); await tick();
    assert.equal(port.status("value").pending, true);
    assert.ok(context);
    const old = context;
    stop();
    releases.push(activateModule(adapter, host)); await tick();
    await assert.rejects(old.refresh("value"), { name: "AbortError" });
    assert.equal(reads, 2);
  });

  it("disposes late setup cleanup without stopping a newer connection", async () => {
    const { host, port } = fixture(); let calls = 0; let reads = 0; let late = 0;
    let finish!: (cleanup: () => void) => void; let context!: BindingConnection;
    const errors: unknown[] = [];
    const adapter = bindModule({ props: { value: { input: () => 1, load: () => ++reads } }, connect: (_host, next) => {
      context = next;
      return ++calls === 1 ? new Promise<() => void>(resolve => { finish = resolve; }) : () => {};
    } });
    const stop = activateModule(adapter, host, error => errors.push(error)); await tick(); stop();
    releases.push(activateModule(adapter, host, error => errors.push(error))); await tick();
    finish(() => { late += 1; }); await tick();
    await context.refresh("value");
    assert.equal(port.read("value"), 2);
    assert.equal(late, 1);
    assert.deepEqual(errors, []);
  });

  it("cleans up a failed browser setup and permits a later successful activation", async () => {
    const { host, port } = fixture(); let setups = 0;
    const errors: unknown[] = [];
    const adapter = bindModule({ props: { value: { input: () => 1, load: () => 10 } }, connect: async () => {
      if (++setups === 1) throw new Error("Setup failed");
    } });
    releases.push(activateModule(adapter, host, error => errors.push(error))); await tick();
    assert.equal((errors[0] as Error).message, "Setup failed");
    releases.push(activateModule(adapter, host, error => errors.push(error))); await tick();
    assert.equal(port.read("value"), 10);
    assert.equal(setups, 2);
  });

  it("rejects mixed/async factories and releases cancelled preparation capabilities", async () => {
    const { host, port } = fixture();
    for (const invalid of [{ create: () => ({}), props: {} }, { create: async () => ({}) }, { create: () => ({ connect: 7 }) }]) {
      const adapter = bindModule(invalid as unknown as BindingModule<typeof host>);
      await assert.rejects(adapter.prepare(host, { phase: "request" }), TypeError);
    }
    const cancellation = new AbortController();
    const adapter = bindModule({ props: { value: { input: () => 1, load: () => new Promise<number>(() => {}) } } });
    const prepared: Promise<BindingPreparation> = adapter.prepare(host, { phase: "request", signal: cancellation.signal });
    await tick(); cancellation.abort();
    await assert.rejects(prepared, { name: "AbortError" });
    const capability = port.source("value"); capability.dispose();
  });
});
