import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { ABSENT, NONCONFORMING } from "../src/expression.js";
import { decodeHydrationValue, encodeHydrationValue } from "../src/hydration-value.js";

describe("rendered instance values", () => {
  it("preserves missing values, negative zero, nested data and authored tag-like values", () => {
    const original = { value: [null, undefined, ABSENT, NONCONFORMING, -0, ["absent"], { kind: "undefined" }] };
    assert.deepEqual(decodeHydrationValue(JSON.parse(JSON.stringify(encodeHydrationValue(original)))), original);
  });

  it("does not change object prototypes through authored property names", () => {
    const original = JSON.parse('{"__proto__":{"polluted":true},"constructor":"authored"}') as unknown;
    const restored = decodeHydrationValue(encodeHydrationValue(original));
    assert.deepEqual(restored, original);
    assert.equal(Object.getPrototypeOf(restored), Object.prototype);
    assert.equal(({} as { polluted?: boolean }).polluted, undefined);
  });

  it("preserves shared object identity between state values", () => {
    const shared = { count: 3 };
    const original = { first: shared, second: shared };
    const restored = decodeHydrationValue(JSON.parse(JSON.stringify(encodeHydrationValue(original)))) as typeof original;
    assert.deepEqual(restored, original);
    assert.equal(restored.first, restored.second);
  });

  it("rejects values that cannot be restored instead of silently changing them", () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    for (const value of [cyclic, () => {}, Symbol("opaque"), new Date(), NaN, Infinity]) {
      assert.throws(() => encodeHydrationValue(value), /HR010/);
    }
  });

  it("rejects malformed and unknown encodings", () => {
    for (const value of [null, [], ["value"], ["unknown"], ["value", {}], ["reference", 100], ["object", [["a", ["value", 1]], ["a", ["value", 2]]]]]) {
      assert.throws(() => decodeHydrationValue(value), /HR010/);
    }
  });
});
