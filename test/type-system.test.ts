import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  formatType,
  parseTypedValue,
  parseTypeExpression,
  serializeTypedValue,
  trustedContent,
  typeScriptType,
} from "../src/type-system.js";

describe("HTML Next type system", () => {
  it("parses and formats every grammar form canonically", () => {
    const source = "object({ name: string, email?: email, roles: list(admin | editor), metadata: record(number), ... })";
    const type = parseTypeExpression(source);
    assert.equal(formatType(type), source);
    assert.equal(
      typeScriptType(type),
      "{ readonly name: string; readonly email?: string; readonly roles: readonly (\"admin\" | \"editor\")[]; readonly metadata: Readonly<Record<string, number>>; readonly [name: string]: unknown }",
    );
  });

  it("defines nullable as value, null, or absence", () => {
    const type = parseTypeExpression("integer?");
    assert.deepEqual(parseTypedValue("42", type), { ok: true, value: 42 });
    assert.deepEqual(parseTypedValue(null, type), { ok: true, value: null });
    assert.deepEqual(parseTypedValue(undefined, type), { ok: true, value: undefined });
  });

  it("parses scalar and web-value terminals", () => {
    const valid: ReadonlyArray<[string, unknown, unknown]> = [
      ["string", "hello", "hello"],
      ["boolean", "false", false],
      ["number", "1.5", 1.5],
      ["integer", "12", 12],
      ["email", "hello@example.com", "hello@example.com"],
      ["url", "https://example.com/a", "https://example.com/a"],
      ["date", "2024-02-29", "2024-02-29"],
      ["time", "23:59:59.125", "23:59:59.125"],
      ["datetime-local", "2024-02-29T23:59", "2024-02-29T23:59"],
      ["month", "2024-02", "2024-02"],
      ["week", "2020-W53", "2020-W53"],
      ["color", "#Aa00Ff", "#aa00ff"],
      ["token", "one-token", "one-token"],
      ["ident", "--accent", "--accent"],
      ["url-value", "./asset.svg#icon", "./asset.svg#icon"],
      ["token-list", "alpha beta", ["alpha", "beta"]],
    ];
    for (const [type, input, output] of valid) {
      assert.deepEqual(parseTypedValue(input, parseTypeExpression(type)), { ok: true, value: output }, type);
    }
  });

  it("rejects malformed native value spaces", () => {
    for (const [type, value] of [
      ["email", "not-an-email"], ["url", "/relative"], ["date", "2023-02-29"],
      ["time", "24:00"], ["datetime-local", "2024-01-01 10:00"], ["month", "2024-13"],
      ["week", "2021-W53"], ["color", "red"], ["token", "two tokens"],
    ] as const) {
      assert.equal(parseTypedValue(value, parseTypeExpression(type)).ok, false, `${type}: ${value}`);
    }
  });

  it("returns every structured failure with a stable path", () => {
    const type = parseTypeExpression(
      "object({ account: object({ email: email, age: integer }), tags: list(token) })",
    );
    const result = parseTypedValue({
      account: { email: "bad", age: 2.5, extra: true },
      tags: ["ok", "two words"],
      surprise: 1,
    }, type);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.deepEqual(result.issues.map((item) => item.path), [
      "$.account.email", "$.account.age", "$.account.extra", "$.tags[1]", "$.surprise",
    ]);
  });

  it("accepts JSON at structured attribute boundaries and serializes canonically", () => {
    const type = parseTypeExpression("object({ count: integer, names: list(string) })");
    const input = '{"count":"2","names":["Ada","Lin"]}';
    assert.equal(serializeTypedValue(input, type), '{"count":2,"names":["Ada","Lin"]}');
  });

  it("requires an explicitly trusted value for trusted content", () => {
    const type = parseTypeExpression("trusted-html");
    assert.equal(parseTypedValue("<b>unsafe</b>", type).ok, false);
    const trusted = trustedContent("trusted-html", "<b>approved</b>");
    assert.deepEqual(parseTypedValue(trusted, type), { ok: true, value: trusted });
  });

  it("reports source positions for malformed type syntax", () => {
    assert.throws(() => parseTypeExpression("object({ a: list(string)"), /character/);
    assert.throws(() => parseTypeExpression("list()"), /Expected a type/);
    assert.throws(() => parseTypeExpression("object({ a: string, a: number })"), /Duplicate/);
  });
});
