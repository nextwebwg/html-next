import assert from "node:assert/strict";
import { describe, it } from "vitest";

import * as runtime from "../src/generated-runtime.js";
import { generateComponent } from "../src/generate.js";
import { parseComponent } from "../src/source-parser.js";
import { valueCheckSource } from "../src/targets/vanilla-blocks.js";
import { normalizeType, parseTypedValue, parseTypeExpression, type TypeInput, type TypeNode } from "../src/type-system.js";

/** A compiled request check, with the generated runtime's exports in scope as a compiled module imports them. */
function compiledCheck(type: TypeNode): (value: unknown) => boolean {
  const names = Object.keys(runtime).filter((name) => /^[A-Za-z_$][\w$]*$/.test(name));
  return new Function(...names, `return ${valueCheckSource(type)};`)(...names.map((name) => (runtime as Record<string, unknown>)[name])) as (value: unknown) => boolean;
}

describe("compiled request checks", () => {
  it("accept exactly the JavaScript values the live runtime's type check accepts", () => {
    class Point { x = 1; }
    const event = new Event("ping");
    const values: readonly unknown[] = [
      undefined, null, "", "ready", "two words", "https://example.com/path", "not a url", "a@b.co", "2026-10-02", "#663399",
      0, 2, -3, 2.5, Number.NaN, Infinity, true, false, [], ["one", "two"], [1, "2"], [1, 2], [{ id: "a", label: "A" }],
      {}, { query: "a" }, { query: 1 }, { query: "a", extra: true }, { id: "a", label: "A" }, { id: "a" }, { src: "x", width: 2 },
      { src: "x", width: 2.5 }, { a: true, b: false }, { a: "true" }, Object.create(null), new Point(), event, () => 1, new Blob(["x"]),
    ];
    const types: readonly (string | TypeInput)[] = [
      "string", "boolean", "number", "integer", "unknown", "event", { kind: "terminal", name: "function" }, "url", "email", "date", "color-hex", "keyword",
      { kind: "terminal", name: "null" }, { kind: "terminal", name: "absent" }, { kind: "keyword", value: "ready" },
      "list(string)", "list(integer)", "list(unknown)", "list(object({ id: string, label: string }))", { kind: "record", value: { kind: "terminal", name: "boolean" } },
      "object({ query: string })", "object({ id: string, label?: string })", "object({ src: string, width?: integer })",
      { kind: "object", fields: [{ name: "query", type: { kind: "terminal", name: "string" }, optional: false }], open: true },
      { kind: "object", fields: [{ name: "toString", type: { kind: "terminal", name: "function" }, optional: false }], open: false },
      { kind: "union", members: [{ kind: "terminal", name: "string" }, { kind: "terminal", name: "null" }] },
      { kind: "union", members: [{ kind: "list", item: { kind: "terminal", name: "string" } }, { kind: "terminal", name: "integer" }] },
      { kind: "constrained", base: { kind: "terminal", name: "number" }, min: 1, max: 5 },
      { kind: "constrained", base: { kind: "terminal", name: "string" }, pattern: "[a-z]+", minLength: 2, maxLength: 5 },
      { kind: "constrained", base: { kind: "terminal", name: "keyword" }, values: ["ready", "done"] },
      { kind: "constrained", base: { kind: "terminal", name: "integer" }, values: [0, 2] },
      { kind: "terminal", name: "trusted-html" }, "keyword+", "keyword#",
    ];
    for (const input of types) {
      const type = typeof input === "string" ? parseTypeExpression(input) : normalizeType(input);
      const check = compiledCheck(type);
      for (const [index, value] of values.entries()) {
        assert.equal(check(value), parseTypedValue(value, type, "$", "value").ok,
          `${typeof input === "string" ? input : JSON.stringify(input)} with value ${index}`);
      }
    }
  });

  it("are bundled, with host.request, only by a component that declares a request", () => {
    const module = (defs: string): string => generateComponent(parseComponent(`<template component="x-ask" controller="./ask.js"><defs>${defs}</defs><div></div></template>`))
      .find((artifact) => artifact.path === "vanilla/XAsk.js")!.content;
    const asking = module(`<request name="mention-query" type="object({ query: string })" returns="list(string)"></request>`);
    assert.match(asking, /import \{[^}]*\brequestHost\b[^}]*\} from "@nextwebwg\/html-next\/generated-runtime"/);
    assert.match(asking, /const C = \(host, I\) => controller\.default\(requestHost\(host, I\)\);/);
    assert.doesNotMatch(asking, /\bcheck(?:Object|List|String)\b/);
    const plain = module("");
    assert.doesNotMatch(plain, /requestHost|plainObject|q: \{/);
  });

  it("are written out for the declared type, without the full type checker", () => {
    assert.equal(valueCheckSource(parseTypeExpression("list(object({ id: string, label?: string }))")),
      '(v0) => (Array.isArray(v0) && v0.every((v1) => (plainObject(v1) && "id" in v1 && typeof v1["id"] == "string" && (!("label" in v1) || typeof v1["label"] == "string") && Object.keys(v1).every((v2) => ["id","label"].includes(v2)))))');
    // A separated list's text form defers to its full check.
    assert.match(valueCheckSource(parseTypeExpression("keyword+")), /^detailCheck\(checkSeparated\(/);
  });
});
