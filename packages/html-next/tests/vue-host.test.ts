import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { describe, it } from "vitest";
import { computed, createSSRApp, h, nextTick, onServerPrefetch, shallowRef, watchEffect } from "vue";
import { renderToString } from "@vue/server-renderer";

import { transform } from "esbuild";

import * as decimal from "../src/decimal.js";
import { generateVueComponent, vueHostArtifact } from "../src/generate.js";
import { parseComponent } from "../src/source-parser.js";
import { copyStateSeed, READY_INPUT, type InputStatus } from "../src/inputs.js";
import { bindModule } from "../src/bindings.js";
import { PropInputs } from "../src/prop-inputs.js";

async function loadReactiveHost() {
  const { code } = await transform(vueHostArtifact().content, { loader: "ts", format: "esm" });
  const vue = pathToFileURL(createRequire(import.meta.url).resolve("vue")).href;
  const linked = code.replace(/from\s+["']vue["'];?/, `from ${JSON.stringify(vue)};`);
  return import(`data:text/javascript;base64,${Buffer.from(linked).toString("base64")}`) as Promise<{
    useComponentHost(loader: () => Promise<unknown>, options: Record<string, unknown>): { readonly props: Record<string, { readonly value: unknown }> };
    initializedState<T>(evaluate: () => { value: unknown; status: InputStatus }, accepts: (value: unknown) => boolean,
      copy: <V>(value: V) => V, warn: () => void): { value: T | null | undefined; status(): InputStatus; start(): void };
    cycleCheckedComputed<T>(evaluate: () => T): { readonly value: T };
  }>;
}

/** The shared Vue host as a consumer receives it, with Vue itself stubbed: dispatch uses none of it. */
async function loadHost(incoming?: Record<string, unknown>) {
  const { code } = await transform(vueHostArtifact().content, { loader: "ts", format: "esm" });
  const instance = incoming === undefined ? "null" : JSON.stringify({ vnode: { props: incoming } });
  const stubbed = code.replace(/from\s+["']vue["'];?/, `from 'data:text/javascript,export const customRef=()=>{},ref=()=>{},computed=()=>{},getCurrentInstance=()=>(${instance}),onBeforeUnmount=()=>{},onBeforeUpdate=()=>{},onMounted=()=>{},onUpdated=()=>{},shallowRef=()=>{},useSlots=()=>({}),watch=()=>{},watchEffect=()=>{},Fragment={},createCommentVNode=()=>{},createTextVNode=()=>{},defineComponent=(options)=>options,h=()=>{},inject=()=>undefined';`);
  return import(`data:text/javascript;base64,${Buffer.from(stubbed).toString("base64")}`) as Promise<{
    useReflectedProp: () => (name: string, kebab: string, value: unknown, fallback: string | undefined, bound: boolean) => string | undefined;
    createDispatch: (
      root: { value: null },
      emit: (name: string, detail: unknown) => void,
      options: { modeled?: string[] },
    ) => (name: string, detail?: unknown) => boolean;
  }>;
}

describe("the shared Vue host", () => {
  it("keeps structured hydration data stable without freezing authored bindings or scalar props", async () => {
    const { useReflectedProp } = await loadHost({ content: {}, label: "" });
    const reflect = useReflectedProp();
    const first = reflect("content", "content", { text: "First" }, undefined, false);
    assert.equal(reflect("content", "content", { text: "Changed" }, undefined, false), first);
    assert.equal(reflect("content", "content", { text: "Bound" }, undefined, true), '{"text":"Bound"}');
    assert.equal(reflect("label", "label", "Changed", undefined, false), "Changed");
    assert.equal(reflect("content", "content", null, undefined, false), undefined);
  });

  it("prepares dependent providers before SSR without connecting browser behavior", async () => {
    const { useComponentHost } = await loadReactiveHost();
    let loads = 0;
    const query = shallowRef("Server");
    const html = await renderToString(createSSRApp({ setup() {
      const values: Record<string, unknown> = { first: null, result: null };
      const version = shallowRef(0);
      const inputs = new PropInputs({ names: Object.keys(values), values, defaults: {},
        check: (_name, value) => typeof value === "string" ? { ok: true, value } : { ok: false }, invalidate() { version.value += 1; } });
      const host = useComponentHost(async () => ({ connect() { assert.fail("browser connection during SSR"); } }), {
        root: shallowRef(null), dispatch: () => true, props: computed(() => { void version.value; return { ...values }; }), propNames: Object.keys(values), inputs,
        inputTracking: { track() { void version.value; }, untracked: <T>(run: () => T) => run() }, state: { query },
      });
      onServerPrefetch(async () => {
        const binding = bindModule({ props: {
          first: { input: (_props, { state }) => state.query, async load(value) { loads += 1; await Promise.resolve(); return value; } },
          result: { input: props => props.first, load(value) { loads += 1; return `${value}!`; } },
        }, connect() { assert.fail("binding browser behavior during preparation"); } });
        const prepared = await binding.prepare(host, { phase: "request" });
        prepared.dispose();
      });
      return () => h("output", String(host.props.result!.value));
    } }));
    assert.equal(html, "<output>Server!</output>");
    assert.equal(loads, 2);
    query.value = "After disposal";
    await nextTick();
    assert.equal(loads, 2, "preparation releases its subscriptions");
  });

  it("returns a late seed synchronously without notifying consumers during its computed read", async () => {
    const { initializedState, cycleCheckedComputed } = await loadReactiveHost();
    const source = shallowRef<{ value: unknown; status: InputStatus }>({ value: undefined, status: { ...READY_INPUT, ready: false } });
    const state = initializedState<string>(() => source.value, (value) => typeof value === "string", (value) => value, () => assert.fail("invalid seed"));
    let projecting = false;
    const projection = cycleCheckedComputed(() => {
      projecting = true;
      try { return state.value ?? "Waiting"; } finally { projecting = false; }
    });
    assert.equal(projection.value, "Waiting");
    let notificationsDuringRead = 0;
    const stopState = watchEffect(() => { void state.value; }, {
      onTrigger() { if (projecting) notificationsDuringRead += 1; },
    });
    try {
      source.value = { value: "Ready", status: READY_INPUT };
      assert.equal(projection.value, "Ready", "the first usable seed is available synchronously");
      await nextTick();
      assert.equal(notificationsDuringRead, 0, "initialization must not notify existing consumers during a computed read");
      assert.equal(state.value, "Ready");
    } finally { stopState(); }
  });

  it("owns a copied late seed and keeps subsequent nested edits reactive", async () => {
    const { initializedState } = await loadReactiveHost();
    const source = shallowRef<{ value: unknown; status: InputStatus }>({ value: undefined, status: { ...READY_INPUT, ready: false } });
    const state = initializedState<{ name: string }>(() => source.value, (value) => typeof value === "object" && value !== null,
      copyStateSeed, () => assert.fail("invalid seed"));
    state.start();
    const input = { name: "Seed" };
    source.value = { value: input, status: READY_INPUT };
    assert.equal(state.value?.name, "Seed");
    await nextTick();
    const seen: string[] = [];
    const stop = watchEffect(() => { seen.push(state.value!.name); });
    try {
      state.value!.name = "Edited";
      await nextTick();
      source.value = { value: { name: "Replacement" }, status: READY_INPUT };
      await nextTick();
      assert.deepEqual(seen, ["Seed", "Edited"]);
      assert.equal(input.name, "Seed");
      assert.equal(state.value!.name, "Edited");
    } finally { stop(); }
  });

  it("preserves early empty and null edits and refuses stale seeds", async () => {
    const { initializedState } = await loadReactiveHost();
    for (const edit of ["", null]) {
      const source = shallowRef({ value: "Stale", status: { ...READY_INPUT, stale: true } });
      const state = initializedState<string>(() => source.value, (value) => typeof value === "string", copyStateSeed, () => assert.fail("invalid seed"));
      assert.equal(state.value, undefined);
      state.value = edit;
      source.value = { value: "New", status: { ...READY_INPUT, stale: false } };
      await nextTick();
      assert.equal(state.value, edit);
      assert.deepEqual(state.status(), READY_INPUT);
    }
  });

  it("still rejects an actual computed dependency cycle", async () => {
    const { cycleCheckedComputed } = await loadReactiveHost();
    const cycle: { readonly value: unknown } = cycleCheckedComputed(() => cycle.value);
    assert.throws(() => cycle.value, /HR006/);
  });

  it("carries src/decimal.ts as the decimal operations converted arithmetic calls", async () => {
    const host = await loadHost() as unknown as Record<string, (a: number, b: number) => number>;
    const operations = [["decimalAdd", decimal.add], ["decimalSubtract", decimal.subtract], ["decimalMultiply", decimal.multiply],
      ["decimalDivide", decimal.divide], ["decimalRemainder", decimal.remainder]] as const;
    for (const [a, b] of [[1.1, 0.1], [0.3, 0.1], [1.25, 2], [-5.5, 2], [1e-7, 2e-7], [1, 3], [1.5e-23, 1e-24], [-1.5, 0]]) {
      for (const [name, operate] of operations) assert.ok(Object.is(host[name]!(a!, b!), operate(a!, b!)), `${name}(${a}, ${b})`);
    }
  });

  it("imports only the decimal operations a component's number arithmetic uses", () => {
    const vue = (defs: string, body: string): string =>
      generateVueComponent(parseComponent(`<template component="x-t"><defs>${defs}</defs>${body}</template>`, "x-t.html"));
    assert.doesNotMatch(vue(`<state name="n" type="integer" value="1"></state>`, `<p>{$n + 1} {$n * 2 - 1} {$n % 2} {$n / 2}</p>`), /decimal/);
    const fractional = vue(`<state name="level" type="number" value="0"></state>`, `<p>{$level + 0.1}</p>`);
    assert.match(fractional, /import \{[^}]*\bdecimalAdd\b[^}]*\} from '\.\/host'/);
    assert.doesNotMatch(fractional, /decimal(?:Subtract|Multiply|Divide|Remainder)/);
  });

  it("updates a modeled prop once when one change is reported by more than one event", async () => {
    const { createDispatch } = await loadHost();
    const emitted: Array<[string, unknown]> = [];
    const dispatch = createDispatch({ value: null }, (name, detail) => emitted.push([name, detail]), { modeled: ["value"] });

    // A radio group reports one choice as select, then change; both carry the value.
    dispatch("select", { value: "b", previousValue: "a", trigger: "pointer" });
    dispatch("change", { checked: true, value: "b", trigger: "pointer" });

    assert.deepEqual(emitted.filter(([name]) => name === "update:value"), [["update:value", "b"]]);
    assert.deepEqual(emitted.map(([name]) => name), ["update:value"]);
  });

  it("still updates for each distinct value, and for the same value in a later change", async () => {
    const { createDispatch } = await loadHost();
    const updates: unknown[] = [];
    const dispatch = createDispatch({ value: null }, (name, detail) => {
      if (name === "update:value") updates.push(detail);
    }, { modeled: ["value"] });

    dispatch("select", { value: "b" });
    dispatch("select", { value: "c" });
    await Promise.resolve();
    // A parent may have put the prop back; choosing the same value again is a new change.
    dispatch("select", { value: "c" });

    assert.deepEqual(updates, ["b", "c", "c"]);
  });
});
