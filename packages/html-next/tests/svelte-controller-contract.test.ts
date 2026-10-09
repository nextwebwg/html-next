import assert from "node:assert/strict";
import { transform } from "esbuild";
import { compile, compileModule } from "svelte/compiler";
import { describe, it } from "vitest";
import { parseComponent } from "../src/source-parser.js";
import { generateSvelteOutput } from "../src/targets/svelte.js";
import { svelteHostArtifact } from "../src/targets/svelte-host.js";

const source = `<template component="x-event-host" controller="./controller.js">
  <defs>
  <state name="count" type="number" value="1"></state>
  <computed name="doubled" type="number" from="$count * 2"></computed>
  <data name="search" type="string" src="./search.txt"></data>
  <event name="activate" type="event"></event>
  <handler name="forward"><dispatch event="activate" expr:value="$$event"></dispatch></handler>
  </defs>
  <button on:click="forward">Activate</button>
</template>`;

describe("Svelte controller event contract", () => {
  it("lowers the native triggering event into an invocation-local handler parameter", async () => {
    const output = generateSvelteOutput(parseComponent(source, "x-event-host.html"), "test");
    assert.match(output.component, /function forward\(event: Event\): void/);
    assert.match(output.component, /const detail: unknown = event;/);
    assert.doesNotMatch(output.component, /checkedProps\['\$\$event'\]/);
    compile(output.component, { filename: "EventHost.svelte", generate: "client" });

    // Execute the emitted handler, including its actual argument forwarding.
    const handler = output.component.match(/function forward\(event: Event\): void \{[\s\S]*?\n\t\}/)![0];
    const { code } = await transform(`let rootElement = null; const dispatchDeclared = (_root: unknown, _name: string, detail: unknown) => detail;\n${handler.replace(/dispatchDeclared\(\s*rootElement/, "captured = dispatchDeclared(rootElement")}\nlet captured: unknown; export { forward }; export const payload = () => captured;`, { loader: "ts", format: "esm" });
    const emitted = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
    const event = new CustomEvent("click", { detail: 42 });
    emitted.forward(event);
    assert.equal(emitted.payload(), event);
  });

  it("generates separate resource getters and typed state destination checks", () => {
    const output = generateSvelteOutput(parseComponent(source, "x-event-host.html"), "test");
    assert.match(output.component, /computed: \{ doubled:/);
    assert.doesNotMatch(output.component, /computed: \{[^\n]*\bsearch\b/);
    assert.match(output.component, /data: \{ search:/);
    assert.match(output.component, /acceptsState:/);
    assert.match(output.component, /import \{ acceptsControllerWrite \} from '\.\/props'/);
    assert.ok(output.helpers.includes("props"));
  });

  it("includes the typed destination helper only when controller state declares a type", () => {
    const onlyState = `<template component="x-state-host" controller="./controller.js"><defs><state name="count" type="number" value="1"></state></defs><button>Count</button></template>`;
    const typed = generateSvelteOutput(parseComponent(onlyState), "test");
    assert.ok(typed.helpers.includes("props"));
    assert.match(typed.component, /acceptsControllerWrite/);
    const untyped = generateSvelteOutput(parseComponent(onlyState.replace(' type="number"', "")), "test");
    assert.ok(!untyped.helpers.includes("props"));
    assert.doesNotMatch(untyped.component, /acceptsControllerWrite/);
  });

  it("lowers native event fields in guards and payload subsets", () => {
    const subset = source.replace('name="activate" type="event"', 'name="activate" type="number"')
      .replace('expr:value="$$event"', () => 'expr:value="$$event.detail" $if="$$event.type = \'click\'"');
    const output = generateSvelteOutput(parseComponent(subset), "test");
    assert.match(output.component, /event[^\n]*\.type/);
    assert.match(output.component, /event[^\n]*\.detail/);
    compile(output.component, { filename: "EventSubset.svelte", generate: "client" });
  });

  it("retains the outer triggering event across a nested synchronous handler invocation", async () => {
    const nested = source.replace('<dispatch event="activate" expr:value="$$event"></dispatch>',
      () => '<dispatch event="activate" expr:value="$$event"></dispatch><dispatch event="activate" expr:value="$$event"></dispatch>');
    const output = generateSvelteOutput(parseComponent(nested), "test");
    const handler = output.component.match(/function forward\(event: Event\): void \{[\s\S]*?\n\t\}/)![0];
    const { code } = await transform(`let rootElement = null;
      export const seen: Event[] = []; export const inner = new Event("inner");
      const dispatchDeclared = (_root: unknown, _name: string, detail: Event) => { seen.push(detail); if (seen.length === 1) forward(inner); };
      ${handler} export { forward };`, { loader: "ts", format: "esm" });
    const emitted = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
    const outer = new Event("outer");
    emitted.forward(outer);
    assert.deepEqual(emitted.seen, [outer, emitted.inner, emitted.inner, outer]);
  });

  it("includes the shared namespace contract and lifecycle events without element methods", async () => {
    const host = svelteHostArtifact("test").content;
    assert.match(host, /controllerNamespaces\(options, options.definition\)/);
    assert.match(host, /readonly data: Readonly<Record<string, unknown>>/);
    assert.match(host, /on\(type, callback\)/);
    assert.match(host, /new Event\("connect"\)/);
    assert.match(host, /new Event\("disconnect"\)/);
    assert.doesNotMatch(host, /invoke\(|options.methods|Object.defineProperty\(next/);
    const { code } = await transform(host, { loader: "ts", format: "esm" });
    compileModule(code, { filename: "host.svelte.js", generate: "client" });
  });

  it("initializes once, reconnects listeners, and disposes connect work on disconnect", async () => {
    const hostSource = svelteHostArtifact("test").content.replace(/^import .*;\n/gm, "");
    const { code } = await transform(`
      const untrack = (run: () => unknown) => run();
      const flushSync = () => {};
      const cycleCheckedComputed = (read: () => unknown) => ({ get: read });
      const $state = Object.assign((value: unknown) => value, { raw: (value: unknown) => value });
      const $effect = Object.assign((run: () => unknown) => { run(); }, { tracking: () => false, root: (run: () => void) => { run(); return () => {}; } });
      let observation: (() => void) | undefined;
      const observeConnection = (_root: unknown, check: () => void) => { observation = check; return () => {}; };
      export const check = () => observation?.();
      ${hostSource}`, { loader: "ts", format: "esm" });
    const { useComponentHost, check } = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
    const root = Object.assign(new EventTarget(), { isConnected: true });
    let currentRoot = root;
    const sequence: string[] = [];
    let initialized = 0;
    let host: any;
    let stopActivate: () => void;
    const ready = new Promise<void>((resolve) => {
      useComponentHost(async () => ({ default(value: any) {
        initialized += 1;
        host = value;
        host.on("connect", (event: Event) => {
          sequence.push(event.type);
          return () => sequence.push("dispose");
        });
        host.on("disconnect", (event: Event) => sequence.push(event.type));
        stopActivate = host.on("activate", (event: CustomEvent) => sequence.push(String(event.detail)));
        resolve();
      } }), {
        root: () => currentRoot, ownsRoot: () => true, definition: "https://example.test/component.html",
        controller: "./controller.js", tag: "x-event-host", props: () => ({}), state: {}, computed: {}, refs: new Map(),
        dispatch: (element: EventTarget, name: string, detail: unknown) => element.dispatchEvent(new CustomEvent(name, { detail })),
      });
    });
    await ready;
    host.dispatch("activate", 42);
    root.isConnected = false; check();
    root.dispatchEvent(new CustomEvent("activate", { detail: "detached" }));
    root.isConnected = true; check();
    root.dispatchEvent(new CustomEvent("activate", { detail: "again" }));
    const replacement = Object.assign(new EventTarget(), { isConnected: true });
    currentRoot = replacement; check();
    root.dispatchEvent(new CustomEvent("activate", { detail: "old-root" }));
    replacement.dispatchEvent(new CustomEvent("activate", { detail: "new-root" }));
    stopActivate!();
    replacement.dispatchEvent(new CustomEvent("activate", { detail: "unsubscribed" }));
    replacement.isConnected = false; check();
    assert.equal(initialized, 1);
    assert.deepEqual(sequence, ["connect", "42", "disconnect", "dispose", "connect", "again", "new-root", "disconnect", "dispose"]);
  });
});
