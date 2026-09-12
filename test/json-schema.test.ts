import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { validateJsonSchema } from "../src/json-schema.js";

describe("JSON Schema validation", () => {
  it("reports structured paths across objects, arrays, formats, and local references", () => {
    const issues = validateJsonSchema(
      { contact: { email: "bad" }, scores: [1, 1], extra: true },
      {
        type: "object",
        required: ["name"],
        properties: {
          contact: { $ref: "#/$defs/contact" },
          scores: { type: "array", uniqueItems: true, items: { type: "integer", minimum: 2 } },
        },
        additionalProperties: false,
        $defs: {
          contact: {
            type: "object",
            properties: { email: { type: "string", format: "email" } },
          },
        },
      },
    );
    assert.deepEqual(issues.map((item) => item.path), [
      "$.name", "$.contact.email", "$.scores", "$.scores[0]", "$.scores[1]", "$.extra",
    ]);
  });

  it("supports enum, const, composition, and numeric boundaries", () => {
    assert.equal(validateJsonSchema(4, {
      allOf: [{ type: "number", minimum: 2 }, { maximum: 6 }],
      not: { const: 5 },
      multipleOf: 2,
    }).length, 0);
    assert.equal(validateJsonSchema("blue", { enum: ["red", "green"] }).length, 1);
    assert.equal(validateJsonSchema(5, { oneOf: [{ type: "number" }, { const: 5 }] }).length, 1);
  });
});
