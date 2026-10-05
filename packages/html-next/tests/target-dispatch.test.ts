import assert from "node:assert/strict";
import { describe, it, vi } from "vitest";
import { transform } from "esbuild";
import { JSDOM } from "jsdom";
import * as Vue from "vue";
import React from "react";

import { nativeEventsModule } from "../src/targets/react-events.js";
import { reactPropsArtifact } from "../src/targets/react-props.js";
import { vueHostModule } from "../src/targets/vue-host.js";
import { parseTypeExpression, parseTypedValue } from "../src/type-system.js";

async function dispatcher(kind: "React/Svelte" | "Vue") {
  const type = parseTypeExpression("object({ n: number })");
  const modules = new Map<string, unknown>([["vue", Vue], ["react", React]]);
  const evaluate = async (source: string) => {
    const compiled = await transform(source, { loader: "ts", format: "cjs", target: "es2022" });
    const module = { exports: {} as Record<string, any> };
    new Function("require", "module", "exports", compiled.code)((name: string) => modules.get(name), module, module.exports);
    return module.exports;
  };
  let checks = 0;
  const init = { bubbles: false, composed: false, cancelable: true };
  if (kind === "Vue") {
    const { createDispatch } = await evaluate(vueHostModule("test"));
    const send = createDispatch({ value: null }, undefined, { declared: { check: init }, checks: {
      check: (detail: unknown) => { checks++; return parseTypedValue(detail, type).ok; },
    } });
    return { send: (refs: unknown, detail: unknown) => send("check", detail, refs), checks: () => checks };
  }
  const props = await evaluate(reactPropsArtifact("test").content);
  modules.set("./props", { ...props, acceptsDeclaredEvent: (detail: unknown, schema: unknown) => {
    checks++; return props.acceptsDeclaredEvent(detail, schema);
  } });
  const { dispatchDeclaredTargets } = await evaluate(nativeEventsModule("test", true));
  return { send: (refs: unknown, detail: unknown) => dispatchDeclaredTargets(refs, "check", detail, type, init), checks: () => checks };
}

describe("generated collection dispatch", () => {
  for (const kind of ["React/Svelte", "Vue"] as const) {
    it(`${kind} checks once before delivery and preserves a listener-mutated shared payload`, async () => {
      const dom = new JSDOM("<button id='first'></button><button id='second'></button>");
      vi.stubGlobal("CustomEvent", dom.window.CustomEvent);
      try {
        const { send, checks } = await dispatcher(kind);
        const [first, second] = [...dom.window.document.querySelectorAll("button")];
        const payload: { n: number | string } = { n: 1 };
        const values: unknown[] = [];
        const events: Event[] = [];
        first!.addEventListener("check", event => {
          values.push((event as CustomEvent).detail.n); events.push(event); event.preventDefault(); payload.n = "changed";
        });
        second!.addEventListener("check", event => {
          values.push((event as CustomEvent).detail.n); events.push(event);
        });
        send(new Set([second, first]), payload);
        assert.deepEqual(values, [1, "changed"]);
        assert.equal(checks(), 1);
        assert.notEqual(events[0], events[1]);
        assert.equal((events[1] as CustomEvent).detail, payload);
        assert.deepEqual(events.map(event => [event.bubbles, event.composed, event.cancelable, event.defaultPrevented]),
          [[false, false, true, true], [false, false, true, false]]);
      } finally { vi.unstubAllGlobals(); dom.window.close(); }
    });

    it(`${kind} checks invalid payloads even when the ref is empty`, async () => {
      const { send, checks } = await dispatcher(kind);
      assert.throws(() => send([], { n: "invalid" }), /HR002/);
      assert.equal(checks(), 1);
    });

    it(`${kind} snapshots receivers and skips one removed before its turn`, async () => {
      const dom = new JSDOM("<button id='first'></button><button id='second'></button>");
      vi.stubGlobal("CustomEvent", dom.window.CustomEvent);
      try {
        const { send } = await dispatcher(kind);
        const [first, second] = [...dom.window.document.querySelectorAll("button")];
        const refs = new Set([first, second]);
        const observed: string[] = [];
        first!.addEventListener("check", () => {
          observed.push("first"); second!.remove();
          const added = dom.window.document.createElement("button");
          added.addEventListener("check", () => observed.push("added"));
          dom.window.document.body.append(added); refs.add(added);
        });
        second!.addEventListener("check", () => observed.push("removed"));
        send(kind === "Vue" ? [...refs].map($el => ({ $el })) : refs, { n: 1 });
        assert.deepEqual(observed, ["first"]);
      } finally { vi.unstubAllGlobals(); dom.window.close(); }
    });
  }
});
