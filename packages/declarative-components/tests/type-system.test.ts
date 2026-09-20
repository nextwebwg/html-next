import assert from "node:assert/strict";
import { describe, it } from "vitest";

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
    const source = "object({ name: string, email?: string, roles: list(admin | editor), metadata: record(number), ... })";
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

  it("parses scalar terminals", () => {
    const valid: ReadonlyArray<[string, unknown, unknown]> = [
      ["string", "hello", "hello"],
      ["boolean", "false", false],
      ["number", "1.5", 1.5],
      ["integer", "12", 12],
    ];
    for (const [type, input, output] of valid) {
      assert.deepEqual(parseTypedValue(input, parseTypeExpression(type)), { ok: true, value: output }, type);
    }
  });

  it("returns every structured failure with a stable path", () => {
    const type = parseTypeExpression(
      "object({ account: object({ email: string, age: integer }), tags: list(string) })",
    );
    const result = parseTypedValue({
      account: { email: 42, age: 2.5, extra: true },
      tags: ["ok", 17],
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

  it("keeps callbacks and opaque package values property-only", () => {
    const callback = () => undefined;
    assert.deepEqual(parseTypedValue(callback, parseTypeExpression("function")), { ok: true, value: callback });
    assert.deepEqual(parseTypedValue({ provider: callback }, parseTypeExpression("unknown")), {
      ok: true,
      value: { provider: callback },
    });
    assert.equal(typeScriptType(parseTypeExpression("function")), "(...args: readonly unknown[]) => unknown");
    assert.throws(() => serializeTypedValue(callback, parseTypeExpression("function")), /property-only/);
    assert.throws(() => serializeTypedValue({}, parseTypeExpression("unknown")), /property-only/);
  });

  it("reports source positions for malformed type syntax", () => {
    assert.throws(() => parseTypeExpression("object({ a: list(string)"), /character/);
    assert.throws(() => parseTypeExpression("list()"), /Expected a type/);
    assert.throws(() => parseTypeExpression("object({ a: string, a: number })"), /Duplicate/);
  });
});
