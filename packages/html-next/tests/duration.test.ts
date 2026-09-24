import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { parseDuration } from "../src/duration.js";

describe("declaration time values", () => {
  it("reads milliseconds, seconds, and bare numbers", () => {
    assert.deepEqual(
      ["200ms", "0.2s", "2s", "150", " 300 ms ", "0"].map(parseDuration),
      [200, 200, 2000, 150, 300, 0],
    );
  });

  it("rejects values it cannot read rather than treating them as no delay", () => {
    for (const value of ["", "soon", "200 milliseconds", "-5ms", "1e3", "5m"]) {
      assert.equal(parseDuration(value), undefined, `${value} is not a time value`);
    }
  });
});
