import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { transform } from "esbuild";

import { vuePropsArtifact } from "../src/generate.js";
import { parseTypedValue, parseTypeExpression } from "../src/type-system.js";

async function generatedChecker(): Promise<(value: unknown, type: ReturnType<typeof parseTypeExpression>, required: boolean, name: string, pattern?: string) => unknown> {
  const { code } = await transform(vuePropsArtifact().content, { loader: "ts", format: "esm" });
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

  it("rejects malformed functional colors in the server fallback", async () => {
    const checkedProp = await generatedChecker();
    assert.throws(() => checkedProp("rgb(garbage)", parseTypeExpression("color"), false, "color"), /HR002/);
    assert.throws(() => checkedProp("color-mix(in srgb, red, blue)", parseTypeExpression("color"), false, "color"), /HR002/);
    assert.equal(checkedProp("rgb(102 51 153)", parseTypeExpression("color"), false, "color"), "rgb(102 51 153)");
  });

  it("enforces pattern constraints on Vue's typed string values", async () => {
    const checkedProp = await generatedChecker();
    const type = parseTypeExpression("string");
    assert.equal(checkedProp("ABC-1234", type, false, "sku", "[A-Z]{3}-[0-9]{4}"), "ABC-1234");
    assert.throws(() => checkedProp("xABC-1234", type, false, "sku", "[A-Z]{3}-[0-9]{4}"), /HR002/);
  });

  it("checks Vue values as typed values without HTML attribute coercion", async () => {
    const checkedProp = await generatedChecker();
    const samples: readonly (readonly [string, unknown])[] = [
      ["string", "hello"], ["string", 7],
      ["boolean", false], ["boolean", "false"],
      ["number", 42], ["number", "42"], ["number", Infinity],
      ["integer", 3], ["integer", 3.5],
      ["enum(true, false, 'page')", false], ["enum(true, false, 'page')", "false"],
      ["enum(true, false, 'page')", "page"],
      ["list(integer)", [1, 2]], ["list(integer)", "[1,2]"],
      ["object({ id: integer, label?: string })", { id: 2 }],
      ["object({ id: integer, label?: string })", "{ id: 2 }"],
    ];

    for (const [type, value] of samples) {
      const node = parseTypeExpression(type);
      const canonical = parseTypedValue(value, node, "$", "value");
      if (canonical.ok) assert.deepEqual(checkedProp(value, node, false, "value"), canonical.value, `${type}: valid value`);
      else assert.throws(
        () => checkedProp(value, node, false, "value"),
        (error) => error instanceof Error && error.name === "HtmlDiagnosticError" &&
          error.message.startsWith("HR002: A prop invocation value does not satisfy its declared type."),
        `${type}: invalid value`,
      );
    }
  });

  it("distinguishes absent optional and required props", async () => {
    const checkedProp = await generatedChecker();
    const type = parseTypeExpression("number");
    assert.equal(checkedProp(undefined, type, false, "count"), null);
    assert.equal(checkedProp(null, type, false, "count"), null);
    assert.throws(
      () => checkedProp(undefined, type, true, "count"),
      (error) => error instanceof Error && error.name === "HtmlDiagnosticError" &&
        error.message === "HC020: Required prop `count` was not provided.",
    );
    assert.throws(
      () => checkedProp(null, type, true, "count"),
      (error) => error instanceof Error && error.message === "HC021: A required prop cannot be null.",
    );
  });
});
