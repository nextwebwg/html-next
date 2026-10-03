import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { describe, it } from "vitest";

import { build } from "esbuild";
import { parseTypeExpression, parseTypedValue, reactPropsArtifact, type TypeInput } from "@nextwebwg/html-next";

async function generatedEventCheck(): Promise<(value: unknown, type: TypeInput) => boolean> {
  const bundle = await build({
    stdin: { contents: reactPropsArtifact().content, loader: "ts" },
    bundle: true, write: false, platform: "node", format: "cjs", external: ["react"],
  });
  const module = { exports: {} as { acceptsDeclaredEvent(value: unknown, type: TypeInput): boolean } };
  new Function("require", "module", "exports", bundle.outputFiles[0]!.text)(
    createRequire(import.meta.url), module, module.exports,
  );
  return module.exports.acceptsDeclaredEvent;
}

describe("generated React declared-event types", () => {
  it("accepts the same JavaScript values as the canonical type parser", async () => {
    const accepts = await generatedEventCheck();
    const cases: readonly (readonly [string | TypeInput, unknown])[] = [
      ["string", "ready"], ["string", 2],
      ["boolean", true], ["boolean", "true"],
      ["number", 7], ["number", "7"], ["number", Infinity],
      ["integer", 7], ["integer", 7.5],
      [{ kind: "terminal", name: "null" }, null], [{ kind: "terminal", name: "null" }, undefined],
      [{ kind: "terminal", name: "absent" }, undefined],
      ["keyword", "ready"], ["keyword", "not ready"],
      ["email", "person@example.com"], ["email", "not an email"],
      ["date", "2026-10-02"], ["date", "2026-02-30"],
      ["keyword+", ["one", "two"]], ["keyword+", "one two"], ["keyword+", []],
      ["keyword#", ["one", "two"]], ["keyword#", "one,two"],
      ["list(integer)", [1, 2]], ["list(integer)", [1, "2"]], ["list(integer)", "[1,2]"],
      [{ kind: "record", value: { kind: "terminal", name: "boolean" } }, { a: true, b: false }],
      [{ kind: "record", value: { kind: "terminal", name: "boolean" } }, { a: "true" }],
      ["object({ id: integer, label?: string })", { id: 2 }],
      ["object({ id: integer, label?: string })", { id: 2, extra: true }],
      ["object({ id: integer, label?: string })", { id: "2" }],
      [{ kind: "union", members: [{ kind: "terminal", name: "number" }, { kind: "terminal", name: "null" }] }, null],
      [{ kind: "union", members: [{ kind: "terminal", name: "number" }, { kind: "terminal", name: "null" }] }, 4],
      [{ kind: "union", members: [{ kind: "terminal", name: "number" }, { kind: "terminal", name: "null" }] }, "4"],
      [{ kind: "constrained", base: { kind: "terminal", name: "number" }, min: 1, max: 5 }, 3],
      [{ kind: "constrained", base: { kind: "terminal", name: "number" }, min: 1, max: 5 }, 7],
      [{ kind: "constrained", base: { kind: "terminal", name: "string" }, pattern: "[a-z]+", minLength: 2 }, "ok"],
      [{ kind: "constrained", base: { kind: "terminal", name: "string" }, pattern: "[a-z]+", minLength: 2 }, "X"],
    ];
    for (const [index, [input, value]] of cases.entries()) {
      const type = typeof input === "string" ? parseTypeExpression(input) : input;
      const expected = parseTypedValue(value, type, "$", "value").ok;
      assert.equal(accepts(value, type), expected, `case ${index}: ${typeof input === "string" ? input : JSON.stringify(input)} with ${JSON.stringify(value)}`);
    }
    const formats = ["keyword", "url", "email", "date", "month", "week", "time", "datetime-local",
      "datetime", "color", "color-hex", "length", "percentage", "duration"] as const;
    const values: readonly unknown[] = ["", "ready", "two words", "https://example.com/path", "not a url",
      "a@b", "bad@", "2026-10-02", "2026-02-30", "2026-10", "2026-W40", "13:45",
      "2026-10-02T13:45", "2026-10-02T13:45Z", "#663399", "rgb(102 51 153)",
      "rgb(garbage)", "1rem", "25%", "200ms", 0, 2, false, null, undefined];
    for (const format of formats) {
      const type = parseTypeExpression(format);
      for (const value of values) {
        assert.equal(accepts(value, type), parseTypedValue(value, type, "$", "value").ok,
          `${format} with ${JSON.stringify(value)}`);
      }
    }
  });
});
