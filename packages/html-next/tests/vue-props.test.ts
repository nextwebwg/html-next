import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { build } from "esbuild";

import { vuePropsArtifact } from "../src/generate.js";
import { parseTypedValue, parseTypeExpression } from "../src/type-system.js";

async function generatedChecker(): Promise<(value: unknown, type: ReturnType<typeof parseTypeExpression>, required: boolean, name: string, pattern?: string) => unknown> {
  const bundle = await build({
    stdin: { contents: vuePropsArtifact().content, loader: "ts", resolveDir: new URL("../src", import.meta.url).pathname },
    bundle: true, write: false, platform: "node", format: "esm",
  });
  const code = bundle.outputFiles[0]!.text;
  const module = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
  return module.checkedProp;
}

describe("generated Vue prop boundary", () => {
  it("accepts typed values for every declared base type", async () => {
    const checkedProp = await generatedChecker();
    const samples: ReadonlyArray<[string, unknown]> = [
      ["keyword", "size-2"], ["url", "https://example.org/"], ["email", "ada@example.org"], ["email", "a@b"],
      ["date", "2026-09-29"], ["month", "2026-09"], ["week", "2026-W40"],
      ["time", "13:45"], ["datetime-local", "2026-09-29T13:45"],
      ["datetime", "2026-09-29T13:45Z"], ["color", "#663399"],
      ["color-hex", "#663399cc"], ["length", "1rem"], ["percentage", "25%"],
      ["duration", "200ms"],
    ];
    for (const [name, value] of samples) {
      assert.equal(checkedProp(value, parseTypeExpression(name), false, "value"), value, name);
    }
  });

  it("reads a bare boolean attribute as true, as HTML does", async () => {
    const checkedProp = await generatedChecker();
    assert.equal(checkedProp("", parseTypeExpression("boolean"), false, "decorative"), true);
    assert.equal(checkedProp("", parseTypeExpression("boolean"), true, "decorative"), true);
    assert.equal(checkedProp(false, parseTypeExpression("boolean"), false, "decorative"), false);
    assert.equal(checkedProp(undefined, parseTypeExpression("boolean"), false, "decorative"), null);
    assert.equal(checkedProp("", parseTypeExpression("number"), false, "count"), "");
  });

  it("preserves malformed functional colors for validity reporting", async () => {
    const checkedProp = await generatedChecker();
    assert.equal(checkedProp("rgb(garbage)", parseTypeExpression("color"), false, "color"), "rgb(garbage)");
    assert.equal(checkedProp("color-mix(in srgb, red, blue)", parseTypeExpression("color"), false, "color"), "color-mix(in srgb, red, blue)");
    assert.equal(checkedProp("rgb(102 51 153)", parseTypeExpression("color"), false, "color"), "rgb(102 51 153)");
  });

  it("passes typed strings to the component validity boundary", async () => {
    const checkedProp = await generatedChecker();
    const type = parseTypeExpression("string");
    assert.equal(checkedProp("ABC-1234", type, false, "sku"), "ABC-1234");
    assert.equal(checkedProp("xABC-1234", type, false, "sku"), "xABC-1234");
  });

  it("checks Vue values as typed values without HTML attribute coercion", async () => {
    const checkedProp = await generatedChecker();
    const samples: readonly (readonly [string, unknown])[] = [
      ["string", "hello"], ["string", 7],
      ["boolean", false], ["boolean", "false"],
      ["number", 42], ["number", "42"], ["number", Infinity],
      ["integer", 3], ["integer", 3.5],
      ["list(integer)", [1, 2]], ["list(integer)", "[1,2]"],
      ["object({ id: integer, label?: string })", { id: 2 }],
      ["object({ id: integer, label?: string })", "{ id: 2 }"],
    ];

    for (const [type, value] of samples) {
      const node = parseTypeExpression(type);
      const canonical = parseTypedValue(value, node, "$", "value");
      if (canonical.ok) assert.deepEqual(checkedProp(value, node, false, "value"), canonical.value, `${type}: valid value`);
      else assert.deepEqual(checkedProp(value, node, false, "value"), value, `${type}: invalid value is retained`);
    }
  });

  it("distinguishes absent optional and required props", async () => {
    const checkedProp = await generatedChecker();
    const type = parseTypeExpression("number");
    assert.equal(checkedProp(undefined, type, false, "count"), null);
    assert.equal(checkedProp(null, type, false, "count"), null);
    assert.equal(checkedProp(undefined, type, true, "count"), null);
    assert.equal(checkedProp(null, type, true, "count"), null);
  });
});
