import assert from "node:assert/strict";
import { transform } from "esbuild";
import { describe, it } from "vitest";
import { CONTROLLER_STATE_SOURCE } from "../src/targets/controller-state-source.js";
import { typedPropsModule } from "../src/targets/vue-props.js";

async function moduleFrom(source: string): Promise<any> {
  const compiled = await transform(source, { loader: "ts", format: "esm" });
  return import(`data:text/javascript;base64,${Buffer.from(compiled.code).toString("base64")}`);
}

describe("generated controller namespaces", () => {
  it("keeps native events and validates state paths without exposing resources as state", async () => {
    const { controllerNamespaces } = await moduleFrom(CONTROLLER_STATE_SOURCE + "\nexport { controllerNamespaces };");
    const { acceptsControllerWrite } = await moduleFrom(typedPropsModule("test"));
    let count: unknown = 1;
    const row = { count: 1 };
    const event = new Event("click");
    const types = {
      count: { kind: "terminal", name: "number" },
      row: { kind: "object", open: false, fields: [{ name: "count", optional: false, type: { kind: "terminal", name: "number" } }] },
    };
    const host = controllerNamespaces({
      state: {
        count: { get: () => count, set: (value: unknown) => { count = value; } },
        row: { get: () => row, set: () => {} },
        source: { get: () => event, set: () => {} },
      },
      computed: { doubled: () => Number(count) * 2 },
      data: { search: () => ({ pending: true, value: null }) },
      acceptsState: (name: keyof typeof types, keys: string[], value: unknown) => acceptsControllerWrite(value, types[name], keys),
    }, "test.html");
    const warnings: unknown[] = [];
    const warn = console.warn;
    console.warn = (message) => warnings.push(message);
    try {
      host.state.count = 2;
      host.state.count = "bad";
      host.state.count = "bad";
      host.state.row.count = "bad";
      host.state.doubled = 10;
      host.data.search.pending = false;
      assert.equal(host.state.count, 2);
      assert.equal(host.state.row.count, 1);
      assert.equal(host.state.doubled, 4);
      assert.equal(host.data.search.pending, true);
      assert.equal(host.state.search, undefined);
      assert.equal(host.state.source, event);
      assert.equal(host.state.source.type, "click");
      assert.equal(warnings.length, 4);
    } finally { console.warn = warn; }
  });

  it("checks native event payloads in the generated typed boundary", async () => {
    const { acceptsControllerWrite } = await moduleFrom(typedPropsModule("test"));
    const type = { kind: "terminal", name: "event" };
    assert.equal(acceptsControllerWrite(new CustomEvent("activate", { detail: 42 }), type, []), true);
    assert.equal(acceptsControllerWrite({ type: "click" }, type, []), false);
    assert.equal(acceptsControllerWrite("click", type, []), false);
  });
});
