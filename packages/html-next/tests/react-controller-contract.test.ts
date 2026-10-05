import assert from "node:assert/strict";
import { describe, it, vi } from "vitest";
import { stripTypeScriptTypes } from "node:module";
import { transform } from "esbuild";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

import { parseComponent } from "../src/source-parser.js";
import { generateReactOutput } from "../src/targets/react.js";
import { reactHostArtifact } from "../src/targets/react-host.js";
import { nativeEventsModule } from "../src/targets/react-events.js";
import { reactPropsArtifact } from "../src/targets/react-props.js";

interface Host {
  state: Record<string, unknown>;
  data: Readonly<Record<string, { value: unknown }>>;
  on(type: string, callback: (event: Event) => void | (() => void)): () => void;
  dispatch(type: string, detail?: unknown): boolean;
  computed<T>(run: () => T): { get(): T };
  effect(run: () => void | (() => void)): () => void;
}

async function controllerHarness(controller: (host: Host) => void) {
  const hooks: Array<{ current: unknown }> = [];
  let cursor = 0;
  const layouts: Array<() => void | (() => void)> = [];
  const cleanups: Array<() => void> = [];
  const react = {
    useRef(value: unknown) { return hooks[cursor++] ??= { current: value }; },
    useLayoutEffect(run: () => void | (() => void)) { layouts.push(run); },
  };
  let checkConnection = () => {};
  vi.stubGlobal("MutationObserver", class {
    constructor(check: () => void) { checkConnection = check; }
    observe() {} disconnect() {}
  });
  const source = stripTypeScriptTypes(reactHostArtifact("test").content.replace('import React from "react";', "").replaceAll("export ", ""));
  const useComponentHost = new Function("React", source + "\nreturn useComponentHost;")(react) as
    (loader: () => Promise<unknown>, options: unknown) => void;
  const root = Object.assign(new EventTarget(), {
    isConnected: true, ownerDocument: {}, querySelectorAll: () => [],
  });
  const resource = { value: 7 };
  let count: unknown = 1;
  let model = { amount: 2 };
  let nestedWrites = 0;
  let event: unknown;
  const options = {
    root: { current: root }, definition: "https://example.test/x-probe.html", controller: "./probe.js",
    props: () => ({}), refs: new Map(),
    state: {
      count: { get: () => count, set: (value: unknown) => { count = value; } },
      source: { get: () => event, set: (value: unknown) => { event = value; } },
      model: { get: () => model, set: (value: unknown) => { model = value as typeof model; }, touch: () => { nestedWrites++; } },
    },
    computed: { doubled: () => Number(count) * 2, frozen: () => Object.freeze({ nested: Object.freeze({ value: 7 }) }) }, data: { result: () => resource },
    acceptsState: (name: string, keys: readonly string[], value: unknown) =>
      name === "count" || name === "model" && keys[0] === "amount" ? typeof value === "number" : true,
    dispatch: (target: EventTarget, type: string, detail?: unknown) => target.dispatchEvent(new CustomEvent(type, { detail })),
  };
  const render = () => {
    cursor = 0;
    useComponentHost(async () => ({ default: controller }), options);
    for (const layout of layouts.splice(0)) { const cleanup = layout(); if (cleanup) cleanups.push(cleanup); }
  };
  render();
  for (let i = 0; i < 8; i++) await Promise.resolve();
  return { root, render, checkConnection, model: () => model, nestedWrites: () => nestedWrites, count: () => count, stop: () => { for (const cleanup of cleanups.splice(0)) cleanup(); } };
}

describe("React controller contract", () => {
  it("warns and ignores invalid writes, separates resources, and retains native events", async () => {
    let host!: Host;
    const harness = await controllerHarness((value) => { host = value; });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      host.state.count = "wrong";
      host.state.count = "still wrong";
      host.state.doubled = 9;
      assert.equal(harness.count(), 1);
      assert.equal(host.state.doubled, 2);
      assert.equal(host.state.result, undefined);
      assert.equal(host.data.result!.value, 7);
      host.data.result!.value = 8;
      assert.equal(host.data.result!.value, 7);
      const event = new Event("click");
      host.state.source = event;
      assert.equal(host.state.source, event);
      assert.equal(warning.mock.calls.length, 3);
      host.state.count = 3;
      assert.equal(harness.count(), 3);
    } finally { harness.stop(); warning.mockRestore(); vi.unstubAllGlobals(); }
  });

  it("runs native component and lifecycle listeners with connection cleanup", async () => {
    const events: string[] = [];
    let received: Event | undefined;
    const harness = await controllerHarness((host) => {
      host.on("connect", (event) => {
        assert.ok(event instanceof Event);
        events.push(event.type);
        return () => events.push("dispose");
      });
      host.on("disconnect", (event) => { events.push(event.type); });
      host.on("activate", (event) => { received = event; });
    });
    const event = new CustomEvent("activate", { detail: 42 });
    harness.root.dispatchEvent(event);
    assert.equal(received, event);
    harness.stop();
    harness.root.dispatchEvent(new CustomEvent("activate"));
    assert.equal(received, event);
    assert.deepEqual(events, ["connect", "disconnect", "dispose"]);
    vi.unstubAllGlobals();
  });

  it("validates nested writes and notifies React only after accepted changes", async () => {
    let host!: Host;
    const harness = await controllerHarness((value) => { host = value; });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const model = host.state.model as { amount: unknown };
      model.amount = "wrong";
      assert.equal(harness.model().amount, 2);
      assert.equal(harness.nestedWrites(), 0);
      model.amount = 4;
      assert.equal(harness.model().amount, 4);
      assert.equal(harness.nestedWrites(), 1);
      model.amount = 5;
      assert.equal(harness.model().amount, 5);
      assert.equal(harness.nestedWrites(), 2);
      assert.equal(warning.mock.calls.length, 1);
    } finally { harness.stop(); warning.mockRestore(); vi.unstubAllGlobals(); }
  });

  it("initializes once, resumes effects, and reconnects subscriptions without duplicates", async () => {
    const log: string[] = [];
    let initializations = 0;
    let unsubscribe!: () => void;
    const harness = await controllerHarness((host) => {
      initializations++;
      host.on("connect", () => { log.push("a"); return () => log.push("dispose-a"); });
      unsubscribe = host.on("connect", () => { log.push("b"); });
      host.on("disconnect", () => { log.push("disconnect"); });
      host.on("activate", () => { log.push("activate"); });
      host.effect(() => { log.push("effect"); return () => log.push("pause"); });
    });
    try {
      assert.deepEqual(log, ["a", "b", "effect"]);
      harness.root.isConnected = false;
      harness.checkConnection();
      assert.deepEqual(log, ["a", "b", "effect", "disconnect", "dispose-a", "pause"]);
      harness.root.dispatchEvent(new Event("activate"));
      assert.equal(log.at(-1), "pause");
      unsubscribe();
      harness.root.isConnected = true;
      harness.checkConnection();
      assert.equal(initializations, 1);
      assert.deepEqual(log.slice(-2), ["effect", "a"]);
      harness.root.dispatchEvent(new Event("activate"));
      assert.equal(log.at(-1), "activate");
    } finally { harness.stop(); vi.unstubAllGlobals(); }
  });

  it("blocks readonly deletion and descriptors, and reads frozen computed objects", async () => {
    let host!: Host;
    const harness = await controllerHarness(value => { host = value; });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      assert.equal(Reflect.deleteProperty(host.data.result!, "value"), true);
      assert.equal(host.data.result!.value, 7);
      assert.equal(Reflect.defineProperty(host.data.result!, "value", { value: 8 }), false);
      assert.equal(host.data.result!.value, 7);
      const derived = host.state.frozen as { nested: { value: number } };
      assert.equal(derived.nested.value, 7);
      Reflect.deleteProperty(derived.nested, "value");
      assert.equal(derived.nested.value, 7);
      assert.match(String(warning.mock.calls[0]![0]), /HR007.*read-only/);
    } finally { warning.mockRestore(); harness.stop(); vi.unstubAllGlobals(); }
  });

  it("invalidates controller-local computed values synchronously", async () => {
    let host!: Host;
    const harness = await controllerHarness(value => { host = value; });
    try {
      const cached = host.computed(() => Number(host.state.doubled) * 2);
      assert.equal(cached.get(), 4);
      host.state.count = 2;
      assert.equal(host.state.doubled, 4);
      assert.equal(cached.get(), 8);
    } finally { harness.stop(); vi.unstubAllGlobals(); }
  });

  it("emits typed controller writes and isolates resources from state", () => {
    const output = generateReactOutput(parseComponent(`<template component="x-probe" controller="./probe.js"><defs>
      <state name="count" type="number" value="1"></state>
      <data name="result" src="./result.json" type="number"></data>
    </defs><button></button></template>`), "test");
    assert.match(output.component, /acceptsControllerWrite/);
    assert.match(output.component, /acceptsState:/);
    assert.match(output.component, /data: \{ result:/);
    assert.doesNotMatch(output.component, /methods:/);
    assert.doesNotMatch(reactHostArtifact("test").content, /installMethods|Controller method/);
    assert.ok(output.helpers.includes("props"));
  });

  it("renders synchronous controller and nested dispatch writes using the actual native event", async () => {
    const dom = new JSDOM("<div id='app'></div>", { url: "https://example.test/" });
    for (const name of ["window", "document", "Node", "Event", "MouseEvent", "KeyboardEvent", "CustomEvent", "MutationObserver"] as const) {
      vi.stubGlobal(name, dom.window[name]);
    }
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const modules = new Map<string, unknown>([["react", React]]);
    const evaluate = async (source: string, loader: "ts" | "tsx" = "ts") => {
      const compiled = await transform(source, { loader, format: "cjs", target: "es2022" });
      const module = { exports: {} as Record<string, unknown> };
      new Function("require", "module", "exports", compiled.code)((name: string) => modules.get(name), module, module.exports);
      return module.exports;
    };
    modules.set("./props", await evaluate(reactPropsArtifact("test").content));
    modules.set("./events", await evaluate(nativeEventsModule("test", true)));
    modules.set("./host", await evaluate(reactHostArtifact("test").content));
    modules.set("./context", { componentContext: () => React.createContext({ value: undefined }) });
    const generated = generateReactOutput(parseComponent(`<template component="x-probe" controller="./probe.js"><defs>
      <state name="count" type="number" value="1"></state>
      <computed name="doubled" from="$count * 2"></computed>
      <event name="activate" type="event"></event>
      <event name="snapshot" type="number"></event>
      <handler name="setCount"><set name="count" expr:value="$$event.detail"></set></handler>
      <handler name="activate">
        <dispatch event="activate" expr:value="$$event"></dispatch>
        <set name="count" expr:value="$count + 1"></set>
        <dispatch event="snapshot" expr:value="$count"></dispatch>
      </handler>
    </defs><button on:click="activate" on:set-count="setCount"><output $value="$count"></output></button></template>`), "test").component;
    let received: Event | undefined;
    let computed: unknown;
    let snapshot: unknown;
    modules.set("./probe.js", { default: (host: Host) => {
      host.on("activate", (event) => {
        received = (event as CustomEvent<Event>).detail;
        host.state.count = 10;
        computed = host.state.doubled;
      });
      host.on("snapshot", (event) => { snapshot = (event as CustomEvent).detail; });
    } });
    const component = (await evaluate(generated.replace('import("./probe.js")', 'Promise.resolve(require("./probe.js"))'), "tsx")).default as React.ComponentType;
    const root = createRoot(dom.window.document.querySelector("#app")!);
    try {
      await act(async () => { root.render(React.createElement(component)); });
      const button = dom.window.document.querySelector("button")!;
      const event = new dom.window.MouseEvent("click", { bubbles: true });
      await act(async () => { button.dispatchEvent(event); });
      assert.equal(received, event);
      assert.equal(computed, 20);
      assert.equal(snapshot, 11);
      assert.equal(button.querySelector("output")!.textContent, "11");
      const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        await act(async () => { button.dispatchEvent(new dom.window.CustomEvent("set-count", { detail: "wrong" })); });
        assert.equal(button.querySelector("output")!.textContent, "11");
        await act(async () => { button.dispatchEvent(new dom.window.CustomEvent("set-count", { detail: "still wrong" })); });
        await act(async () => { button.dispatchEvent(new dom.window.CustomEvent("set-count", { detail: null })); });
        assert.equal(button.querySelector("output")!.textContent, "11");
        assert.equal(warning.mock.calls.length, 1);
        assert.match(String(warning.mock.calls[0]![0]), /HR007.*count/);
        await act(async () => { button.dispatchEvent(new dom.window.CustomEvent("set-count", { detail: 12 })); });
        assert.equal(button.querySelector("output")!.textContent, "12");
      } finally { warning.mockRestore(); }
    } finally {
      await act(async () => { root.unmount(); });
      dom.window.close();
      vi.unstubAllGlobals();
    }
  });

  it("passes the actual handler event through native typed dispatch", () => {
    const output = generateReactOutput(parseComponent(`<template component="x-probe"><defs>
      <event name="activate" type="event"></event>
      <handler name="activate"><dispatch event="activate" expr:value="$$event"></dispatch></handler>
    </defs><button on:click="activate"></button></template>`), "test");
    assert.match(output.component, /dispatchDeclared\(rootRef.current, "activate", event,/);
    assert.match(output.component, /handler: \(event: Event\)/);
    assert.doesNotMatch(output.component, /SyntheticEvent/);
  });
});
