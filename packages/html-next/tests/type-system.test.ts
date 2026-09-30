import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  TypeSyntaxError,
  formatType,
  parseTypedValue,
  parseTypeExpression,
  serializeTypedValue,
  typeAtKey,
  typeScriptType,
} from "../src/type-system.js";

describe("HTML Next type system", () => {
  const baseCases: ReadonlyArray<[string, string, unknown]> = [
    ["string", "", ""],
    ["keyword", "size-2", "size-2"],
    ["boolean", "false", false],
    ["integer", "-2", -2],
    ["number", "0.3", 0.3],
    ["url", "https://example.org/", "https://example.org/"],
    ["email", "ada@example.org", "ada@example.org"],
    ["email", "a@b", "a@b"],
    ["date", "2026-09-29", "2026-09-29"],
    ["month", "2026-09", "2026-09"],
    ["week", "2026-W40", "2026-W40"],
    ["time", "13:45", "13:45"],
    ["datetime-local", "2026-09-29T13:45", "2026-09-29T13:45"],
    ["datetime", "2026-09-29T13:45Z", "2026-09-29T13:45Z"],
    ["color", "rebeccapurple", "rebeccapurple"],
    ["color", "rgb(102 51 153)", "rgb(102 51 153)"],
    ["color-hex", "#663399cc", "#663399cc"],
    ["length", "1rem", "1rem"],
    ["percentage", "25%", "25%"],
    ["duration", "200ms", "200ms"],
  ];

  it("parses every base type into the specified JavaScript representation", () => {
    for (const [name, written, expected] of baseCases) {
      const type = parseTypeExpression(name);
      assert.equal(formatType(type), name);
      assert.deepEqual(parseTypedValue(written, type), { ok: true, value: expected }, name);
    }
  });

  it("rejects values outside each base type", () => {
    const invalid: ReadonlyArray<[string, string]> = [
      ["keyword", "two words"], ["integer", "2.5"], ["number", "Infinity"], ["number", "0x10"],
      ["url", "/relative"], ["email", "no-at-sign"], ["email", "a@-b"], ["date", "2026-02-30"],
      ["month", "2026-13"], ["week", "2026-W00"], ["time", "25:00"],
      ["datetime-local", "2026-09-29"], ["datetime", "2026-09-29T13:45"],
      ["color", "rgb(garbage)"], ["color", "color-mix(in srgb, red, blue)"],
      ["color-hex", "#12"], ["length", "4"], ["percentage", "25"], ["duration", "200"],
    ];
    for (const [name, written] of invalid) {
      assert.equal(parseTypedValue(written, parseTypeExpression(name)).ok, false, name);
    }
  });

  it("preserves each typed member of an enum", () => {
    const type = parseTypeExpression("enum(true, false, 'page', 'step', 3)");
    assert.equal(formatType(type), "enum(true, false, 'page', 'step', 3)");
    assert.equal(typeScriptType(type), 'true | false | "page" | "step" | 3');
    for (const [written, expected] of [["false", false], ["3", 3], ["step", "step"]] as const) {
      assert.deepEqual(parseTypedValue(written, type), { ok: true, value: expected });
    }
    assert.equal(parseTypedValue("other", type).ok, false);
    assert.throws(() => parseTypeExpression("enum(false, 'false')"), /same HTML spelling/);
  });

  it("parses separated keyword lists and serializes their declared separator", () => {
    const space = parseTypeExpression("keyword+");
    const comma = parseTypeExpression("keyword#");
    assert.deepEqual(parseTypedValue("red blue", space), { ok: true, value: ["red", "blue"] });
    assert.deepEqual(parseTypedValue("red, blue", comma), { ok: true, value: ["red", "blue"] });
    assert.equal(serializeTypedValue(["red", "blue"], space), "red blue");
    assert.equal(serializeTypedValue(["red", "blue"], comma), "red, blue");
    assert.equal(parseTypedValue("red,,blue", comma).ok, false);
  });

  it("parses authored object and array literals, including bare keys and trailing commas", () => {
    const type = parseTypeExpression("object({ count: integer, names: list(string) })");
    const written = "{ count: 2, names: ['Ada', 'Lin',], }";
    assert.deepEqual(parseTypedValue(written, type), { ok: true, value: { count: 2, names: ["Ada", "Lin"] } });
    assert.equal(parseTypedValue("{ count: currentCount, names: [] }", type).ok, false);
    assert.equal(serializeTypedValue(written, type), '{"count":2,"names":["Ada","Lin"]}');
  });

  it("reports paths for structured failures", () => {
    const type = parseTypeExpression("object({ account: object({ email: string, age: integer }), tags: list(string) })");
    const result = parseTypedValue({ account: { email: 42, age: 2.5, extra: true }, tags: ["ok", 17], surprise: 1 }, type);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.deepEqual(result.issues.map((item) => item.path), [
      "$.account.email", "$.account.age", "$.account.extra", "$.tags[1]", "$.surprise",
    ]);
  });

  it("resolves object and list fields for reference checks", () => {
    const rows = parseTypeExpression("list(object({ id: string, count: integer }))");
    const item = typeAtKey(rows, 0)!;
    assert.equal(formatType(typeAtKey(item, "count")!), "integer");
    assert.equal(formatType(typeAtKey(item, "extra")!), "absent");
    assert.equal(typeAtKey(rows, "id"), undefined);
  });

  it("rejects removed public type syntax", () => {
    for (const old of ["small | large", "number?", "'small'", "record(number)", "<length>", "unknown", "null", "list()"] ) {
      assert.throws(() => parseTypeExpression(old), TypeSyntaxError, old);
    }
  });
});
