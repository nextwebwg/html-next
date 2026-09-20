import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { NATIVE_FLAG, validate, type Validity } from "../src/validate.js";

function reasons(validity: Validity): string[] {
  return validity.errors.map((error) => error.reason);
}

describe("shared validation", () => {
  it("applies required only to empty values", () => {
    assert.equal(validate("", {}).valid, true);
    assert.deepEqual(reasons(validate("", { required: true })), ["valueMissing"]);
    assert.equal(validate(false, { type: "boolean", required: true }).valid, true);
    assert.deepEqual(reasons(validate([], { required: true, multiple: true })), ["valueMissing"]);
  });

  it("validates single and multiple email values", () => {
    assert.equal(validate("ada@example.com", { type: "email" }).valid, true);
    assert.deepEqual(reasons(validate("ada", { type: "email" })), ["typeMismatch"]);
    assert.equal(validate("ada@example.com, lin@example.org", { type: "email", multiple: true }).valid, true);
    const invalid = validate("ada@example.com, no", { type: "email", multiple: true });
    assert.deepEqual(reasons(invalid), ["typeMismatch"]);
    assert.equal(invalid.errors[0]?.path, "$[1]");
  });

  it("validates URLs, numeric input, and date/time families", () => {
    assert.equal(validate("https://example.com", { type: "url" }).valid, true);
    assert.deepEqual(reasons(validate("relative/path", { type: "url" })), ["typeMismatch"]);
    assert.deepEqual(reasons(validate("abc", { type: "number" })), ["badInput"]);
    for (const [type, good, bad] of [
      ["date", "2024-02-29", "2023-02-29"],
      ["time", "12:30", "25:00"],
      ["datetime-local", "2024-02-29T12:30", "2024-02-30T12:30"],
      ["month", "2024-12", "2024-13"],
      ["week", "2020-W53", "2021-W53"],
      ["color", "#00aaff", "blue"],
    ] as const) {
      assert.equal(validate(good, { type }).valid, true, type);
      assert.equal(validate(bad, { type }).valid, false, type);
    }
  });

  it("returns precise range, length, pattern, and step flags", () => {
    assert.deepEqual(reasons(validate("5", { type: "number", min: 10 })), ["rangeUnderflow"]);
    assert.deepEqual(reasons(validate("20", { type: "number", max: 10 })), ["rangeOverflow"]);
    assert.deepEqual(reasons(validate("ab", { type: "string", minLength: 3 })), ["tooShort"]);
    assert.deepEqual(reasons(validate("abcd", { type: "string", maxLength: 3 })), ["tooLong"]);
    assert.deepEqual(reasons(validate("abc1", { type: "string", pattern: "[a-z]+" })), ["patternMismatch"]);
    assert.deepEqual(reasons(validate("7", { type: "number", step: 5 })), ["stepMismatch"]);
    assert.equal(validate("12", { type: "number", min: 2, step: 5 }).valid, true);
  });

  it("returns multiple failures with stable paths", () => {
    const validity = validate({ contact: 42, count: 1.5, extra: true }, {
      type: "object({ contact: string, count: integer })",
    });
    assert.equal(validity.valid, false);
    assert.deepEqual(validity.errors.map((error) => [error.reason, error.path]), [
      ["typeMismatch", "$.contact"],
      ["typeMismatch", "$.count"],
      ["typeMismatch", "$.extra"],
    ]);
  });

  it("ignores an invalid pattern just as HTML does", () => {
    assert.equal(validate("anything", { type: "string", pattern: "([" }).valid, true);
  });

  it("maps every reason to an intentional native or extension flag", () => {
    for (const reason of [
      "valueMissing", "typeMismatch", "patternMismatch", "tooLong", "tooShort",
      "rangeUnderflow", "rangeOverflow", "stepMismatch", "badInput", "customError",
      "schemaMismatch", "untrustedValue",
    ] as const) {
      assert.equal(typeof NATIVE_FLAG[reason], "string");
    }
  });
});
