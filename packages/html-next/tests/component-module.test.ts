import assert from "node:assert/strict";
import { afterAll, describe, it } from "vitest";

import { activateModule, clearControllerCache, loadComponentModule } from "../src/controller.js";
import { parseComponent } from "../src/source-parser.js";
import { buildComponentGraph } from "../src/source-graph.js";
import { ResourceResolver } from "../src/resolve.js";
import type { ComponentHost } from "../src/runtime.js";
import { closeRenderWorkers, renderComponents } from "../src/server.js";
import { componentInputs, createInputPort, INPUT_PORT, READY_INPUT, type InputSource } from "../src/inputs.js";

const source = '<template component="x-module" module="./behavior.js"><div></div></template>';

describe("component modules", () => {
  afterAll(closeRenderWorkers);

  it("renders supplied props on the server without loading browser behavior", async () => {
    const rendered = await renderComponents('<x-module title="Server"></x-module>', {
      definitions: [parseComponent('<template component="x-module" module="./does-not-exist-in-node.js"><defs><prop name="title" type="string" required>Title.</prop></defs><section>{$title}</section></template>')],
    });
    assert.match(rendered.html, />Server<\/section>/);
  });
  it("parses and resolves module without turning it into a legacy controller", async () => {
    const definition = parseComponent(source, "https://example.test/ui/card.html");
    assert.equal(definition.module, "./behavior.js");
    assert.equal(definition.controller, undefined);
    const graph = await buildComponentGraph(["./card.html"], {
      resolver: new ResourceResolver({}, "https://example.test/ui/"),
      fetchComponent: async url => ({ url, source }),
    });
    const node = [...graph.nodes.values()][0]!;
    assert.deepEqual(node.module, { specifier: "./behavior.js", url: "https://example.test/ui/behavior.js" });
    clearControllerCache();
    let imports = 0;
    const importer = async () => { imports += 1; return { connect() {}, props: {} }; };
    assert.equal(await loadComponentModule(node, importer), await loadComponentModule(node, importer));
    assert.equal(imports, 1);
  });

  it("rejects conflicting declarations, empty paths and non-callable connection exports", async () => {
    assert.throws(() => parseComponent(source.replace('module="./behavior.js"', 'module="./behavior.js" controller="./old.js"')), /controller.*module|module.*controller/);
    assert.throws(() => parseComponent(source.replace('./behavior.js', '')), /specifier cannot be empty/);
    const graph = await buildComponentGraph(["./card.html"], {
      resolver: new ResourceResolver({}, "https://example.test/ui/"),
      fetchComponent: async url => ({ url, source }),
    });
    clearControllerCache();
    await assert.rejects(loadComponentModule([...graph.nodes.values()][0]!, async () => ({ connect: 12 })), /connect/);
    clearControllerCache();
    assert.deepEqual(await loadComponentModule([...graph.nodes.values()][0]!, async () => ({ props: {} })), { props: {} });
  });

  it("retains the native module namespace and its live exports without freezing a wrapper", async () => {
    const graph = await buildComponentGraph(["./card.html"], {
      resolver: new ResourceResolver({}, "https://example.test/ui/"),
      fetchComponent: async url => ({ url, source }),
    });
    const url = "data:text/javascript,export let connect; export function replace(value) { connect = value; }";
    const namespace = await import(url) as {
      connect: (host: ComponentHost) => void; replace(value: (host: ComponentHost) => void): void;
    };
    const calls: string[] = [];
    namespace.replace(() => { calls.push("first"); });
    clearControllerCache();
    const module = await loadComponentModule([...graph.nodes.values()][0]!, async () => namespace);
    assert.equal(module, namespace);
    namespace.replace(() => { calls.push("second"); });
    activateModule(module, { state: {} } as unknown as ComponentHost)();
    assert.deepEqual(calls, ["second"]);
  });

  it("gives each activation its own cancellation and cleanup while preserving the host", async () => {
    const host = { state: { count: 0 } } as unknown as ComponentHost;
    const signals: AbortSignal[] = [];
    let cleaned = 0;
    const module = {
      connect(current: ComponentHost, { signal }: { signal: AbortSignal }) {
        assert.equal(current.state, host.state);
        current.state.count = Number(current.state.count) + 1;
        signals.push(signal);
        return () => { cleaned += 1; };
      },
    };
    const first = activateModule(module, host);
    assert.equal(host.state.count, 1);
    first(); first();
    assert.equal(signals[0]!.aborted, true);
    assert.equal(cleaned, 1);
    const second = activateModule(module, host);
    assert.equal(host.state.count, 2);
    assert.notEqual(signals[0], signals[1]);
    assert.equal(signals[1]!.aborted, false);
    second();
    assert.equal(cleaned, 2);
  });

  it("immediately disposes late cleanup and connection-owned host subscriptions", async () => {
    let resolve!: (cleanup: () => void) => void;
    let cleaned = 0;
    let stopped = 0;
    let lateRuns = 0;
    const host = { effect() { lateRuns += 1; return () => { stopped += 1; }; } } as unknown as ComponentHost;
    let connectionHost!: ComponentHost;
    const stop = activateModule({
      connect(current) {
        connectionHost = current;
        current.effect(() => {});
        return new Promise<() => void>(done => { resolve = done; });
      },
    }, host);
    stop();
    assert.equal(stopped, 1);
    connectionHost.effect(() => {});
    assert.equal(lateRuns, 1, "work started through a stale connection host is refused");
    resolve(() => { cleaned += 1; });
    await Promise.resolve();
    assert.equal(cleaned, 1);
  });

  it("ends partial setup on failure and treats cancellation as normal completion", async () => {
    const errors: unknown[] = [];
    let stopped = 0;
    let signal!: AbortSignal;
    const host = { computed() { return { get: () => 1, stop: () => { stopped += 1; } }; } } as unknown as ComponentHost;
    const failure = new Error("setup failed");
    activateModule({ connect(current, context) { signal = context.signal; current.computed(() => 1); throw failure; } }, host, error => errors.push(error));
    assert.equal(signal.aborted, true);
    assert.equal(stopped, 1);
    assert.equal(errors.length, 1);
    assert.equal(errors[0], failure);
    let reject!: (error: unknown) => void;
    const stop = activateModule({ connect() { return new Promise<void>((_done, failed) => { reject = failed; }); } }, host, error => errors.push(error));
    stop();
    reject(new DOMException("Cancelled", "AbortError"));
    await Promise.resolve();
    assert.equal(errors.length, 1);
    assert.equal(errors[0], failure);
  });

  it("owns SDK watchers without ending the instance's input port", () => {
    let runs = 0;
    let stopped = 0;
    const port = { watch() { runs += 1; return () => { stopped += 1; }; }, read() { return "retained"; } };
    const host = { [Symbol.for("@nextwebwg/html-next.inputs.v1")]: port } as unknown as ComponentHost;
    let scopedPort!: typeof port;
    const stop = activateModule({ connect(current) {
      scopedPort = Reflect.get(current, Symbol.for("@nextwebwg/html-next.inputs.v1"));
      scopedPort.watch();
    } }, host);
    stop(); stop();
    assert.equal(stopped, 1);
    scopedPort.watch();
    assert.equal(runs, 1, "a stale connection cannot create a new watcher");
    assert.equal(scopedPort.read(), "retained");
    assert.equal(Reflect.get(host, Symbol.for("@nextwebwg/html-next.inputs.v1")), port);
  });

  it("releases connection sources after failure and refuses writes through stale activations", () => {
    let value: unknown = "Initial";
    const port = createInputPort({ names: ["label"], read: () => value, status: () => READY_INPUT,
      supplied: () => false, watch: () => () => {}, untracked: run => run(),
      publish: (_name, snapshot) => { value = snapshot.value; return true; } });
    const host = { [INPUT_PORT]: port };
    const failure = new Error("Setup failed after starting a source");
    const errors: unknown[] = [];
    let previous!: InputSource;
    let stale!: typeof port;
    activateModule({ connect(current) {
      stale = componentInputs(current);
      previous = stale.source("label");
      previous.publish({ value: "Accepted", status: READY_INPUT });
      throw failure;
    } }, host, error => errors.push(error));
    assert.deepEqual(errors, [failure]);
    assert.equal(previous.publish({ value: "Late", status: READY_INPUT }), false);
    assert.equal(port.read("label"), "Accepted");
    let current!: InputSource;
    const stop = activateModule({ connect(currentHost) { current = componentInputs(currentHost).source("label"); } }, host);
    assert.throws(() => stale.source("label"), { name: "AbortError" });
    previous.dispose();
    assert.equal(current.publish({ value: "Reconnected", status: READY_INPUT }), true);
    stop(); stop();
    assert.equal(current.publish({ value: "Late", status: READY_INPUT }), false);
    assert.equal(port.read("label"), "Reconnected");
    assert.doesNotThrow(() => port.source("label").dispose());
  });
});
