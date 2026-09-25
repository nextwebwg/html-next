import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { transform } from "esbuild";

import { vueHostArtifact } from "../src/generate.js";

/** The shared Vue host as a consumer receives it, with Vue itself stubbed: dispatch uses none of it. */
async function loadHost() {
  const { code } = await transform(vueHostArtifact().content, { loader: "ts", format: "esm" });
  const stubbed = code.replace(/from\s+["']vue["'];?/, "from 'data:text/javascript,export const computed=()=>{},onBeforeUnmount=()=>{},onMounted=()=>{},shallowRef=()=>{},useSlots=()=>({}),watchEffect=()=>{},Fragment={}';");
  return import(`data:text/javascript;base64,${Buffer.from(stubbed).toString("base64")}`) as Promise<{
    createDispatch: (
      root: { value: null },
      emit: (name: string, detail: unknown) => void,
      options: { modeled?: string[] },
    ) => (name: string, detail?: unknown) => boolean;
  }>;
}

describe("the shared Vue host", () => {
  it("updates a modeled prop once when one change is reported by more than one event", async () => {
    const { createDispatch } = await loadHost();
    const emitted: Array<[string, unknown]> = [];
    const dispatch = createDispatch({ value: null }, (name, detail) => emitted.push([name, detail]), { modeled: ["value"] });

    // A radio group reports one choice as select, then change; both carry the value.
    dispatch("select", { value: "b", previousValue: "a", trigger: "pointer" });
    dispatch("change", { checked: true, value: "b", trigger: "pointer" });

    assert.deepEqual(emitted.filter(([name]) => name === "update:value"), [["update:value", "b"]]);
    assert.deepEqual(emitted.map(([name]) => name), ["select", "update:value", "change"]);
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
