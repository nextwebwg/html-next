import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { NATIVE_FLAG, validate, type Validity } from "../src/validate.js";

function reasons(v: Validity): string[] {
  return v.errors.map((e) => e.reason);
}

describe("validate", () => {
  it("an empty optional value is valid", () => {
    assert.deepEqual(validate("", {}), { valid: true, errors: [] });
    assert.equal(validate(undefined, {}).valid, true);
    assert.equal(validate(null, {}).valid, true);
  });

  it("required + empty is missing", () => {
    const v = validate("", { required: true });
    assert.equal(v.valid, false);
    assert.deepEqual(reasons(v), ["missing"]);
  });

  it("a false boolean is not treated as missing", () => {
    assert.equal(validate(false, { type: "boolean", required: true }).valid, true);
  });

  it("number: parses strings, flags unparseable and wrong type", () => {
    assert.equal(validate("42", { type: "number" }).valid, true);
    assert.equal(validate(42, { type: "number" }).valid, true);
    assert.deepEqual(reasons(validate("abc", { type: "number" })), ["unparseable"]);
    assert.deepEqual(reasons(validate(true, { type: "number" })), ["type"]);
  });

  it("enum: membership is a type reason", () => {
    const c = { type: { enum: ["outline", "solid", "ghost"] } as const };
    assert.equal(validate("solid", c).valid, true);
    assert.deepEqual(reasons(validate("plaid", c)), ["type"]);
  });

  it("boolean: accepts booleans and the two string forms", () => {
    assert.equal(validate(true, { type: "boolean" }).valid, true);
    assert.equal(validate("false", { type: "boolean" }).valid, true);
    assert.deepEqual(reasons(validate("yes", { type: "boolean" })), ["type"]);
  });

  it("range: under, over", () => {
    assert.deepEqual(reasons(validate("5", { type: "number", min: 10 })), ["range"]);
    assert.deepEqual(reasons(validate("200", { type: "number", max: 120 })), ["range"]);
    assert.equal(validate("50", { type: "number", min: 0, max: 120 }).valid, true);
  });

  it("length: too short, too long", () => {
    assert.deepEqual(reasons(validate("ab", { type: "string", minLength: 3 })), ["length"]);
    assert.deepEqual(reasons(validate("abcd", { type: "string", maxLength: 3 })), ["length"]);
    assert.equal(validate("abc", { type: "string", minLength: 3, maxLength: 3 }).valid, true);
  });

  it("pattern is anchored to the whole value", () => {
    assert.deepEqual(reasons(validate("abc123", { type: "string", pattern: "[a-z]+" })), ["pattern"]);
    assert.equal(validate("abc", { type: "string", pattern: "[a-z]+" }).valid, true);
  });

  it("step: off and on the grid, relative to min", () => {
    assert.deepEqual(reasons(validate("7", { type: "number", step: 5 })), ["step"]);
    assert.equal(validate("10", { type: "number", step: 5 }).valid, true);
    assert.equal(validate("12", { type: "number", min: 2, step: 5 }).valid, true); // 2,7,12,...
  });

  it("collects multiple reasons at once", () => {
    const v = validate("5", { type: "number", min: 10, step: 3 }); // below min AND off step
    assert.equal(v.valid, false);
    assert.deepEqual(reasons(v).sort(), ["range", "step"]);
  });

  it("an invalid pattern does not constrain (native leniency)", () => {
    assert.equal(validate("anything", { type: "string", pattern: "([" }).valid, true);
  });

  it("every reason maps to a native ValidityState flag", () => {
    for (const reason of ["missing", "type", "range", "length", "pattern", "step", "unparseable"] as const) {
      assert.equal(typeof NATIVE_FLAG[reason], "string");
    }
  });
});
