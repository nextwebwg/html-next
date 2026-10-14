import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { transform } from "esbuild";

import * as decimal from "../src/decimal.js";
import { generateVueComponent, vueHostArtifact } from "../src/generate.js";
import { parseComponent } from "../src/source-parser.js";

/** The shared Vue host as a consumer receives it, with Vue itself stubbed: dispatch uses none of it. */
async function loadHost() {
  const { code } = await transform(vueHostArtifact().content, { loader: "ts", format: "esm" });
  const stubbed = code.replace(/from\s+["']vue["'];?/, "from 'data:text/javascript,export const computed=()=>{},getCurrentInstance=()=>null,onBeforeUnmount=()=>{},onBeforeUpdate=()=>{},onMounted=()=>{},onUpdated=()=>{},shallowRef=()=>{},useSlots=()=>({}),watch=()=>{},watchEffect=()=>{},Fragment={},createTextVNode=()=>{},defineComponent=(options)=>options,h=()=>{},inject=()=>undefined';");
  return import(`data:text/javascript;base64,${Buffer.from(stubbed).toString("base64")}`) as Promise<{
    createDispatch: (
      root: { value: null },
      emit: (name: string, detail: unknown) => void,
      options: { modeled?: string[] },
    ) => (name: string, detail?: unknown) => boolean;
  }>;
}

describe("the shared Vue host", () => {
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
