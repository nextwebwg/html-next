import assert from "node:assert/strict";
import { Decimal } from "decimal.js";
import { describe, it } from "vitest";

import { add, divide, multiply, remainder, subtract } from "../src/decimal.js";
import * as packageIndex from "../src/index.js";
import * as generatedRuntime from "../src/generated-runtime.js";

/** `Object.is`, so a zero's sign counts. */
const same = (actual: number, expected: number, label: string): void =>
  assert.ok(Object.is(actual, expected), `${label}: ${Object.is(actual, -0) ? "-0" : actual} !== ${Object.is(expected, -0) ? "-0" : expected}`);

describe("decimal operations", () => {
  it("are the package's public add, subtract, multiply and divide, and compiled components' helpers", () => {
    assert.deepEqual([packageIndex.add, packageIndex.subtract, packageIndex.multiply, packageIndex.divide], [add, subtract, multiply, divide]);
    assert.equal("remainder" in packageIndex, false);
    assert.deepEqual([generatedRuntime.add, generatedRuntime.subtract, generatedRuntime.multiply, generatedRuntime.divide,
      generatedRuntime.remainder], [add, subtract, multiply, divide, remainder]);
  });

  it("add rounds to the larger operand's places", () => {
    same(add(1.1, 0.1), 1.2, "1.1 + 0.1");
    same(add(0.1, 0.2), 0.3, "0.1 + 0.2");
    same(add(-1.1, -0.1), -1.2, "-1.1 + -0.1");
    same(add(0.7, -1), -0.3, "0.7 + -1");
    same(add(1.005, 1), 2.005, "1.005 + 1");
    same(add(1e-7, 2e-7), 3e-7, "exponent forms");
    same(add(1.5e-23, 1e-24), 1.6e-23, "past 22 places");
    same(add(2, 3), 5, "integers");
    same(add(-0.5, 0.5), 0, "a zero sum is +0");
    same(add(-0, -0), -0, "-0 + -0");
    // 15 significant digits at the result's places is the limit; past it the double result stands.
    same(add(123456789012.345, 0.001), 123456789012.346, "15 digits");
    same(add(1234567890123.45, 0.001), 1234567890123.45 + 0.001, "16 digits");
    same(add(2 ** 53, 1), 2 ** 53, "integers past 2^53");
    same(add(1e300, 1.5), 1e300, "large magnitudes");
    same(add(Number.NaN, 0.1), Number.NaN, "NaN");
    same(add(Infinity, 0.1), Infinity, "Infinity");
    same(add(Number.MAX_VALUE, Number.MAX_VALUE), Infinity, "overflow");
  });

  it("subtract rounds to the larger operand's places", () => {
    same(subtract(0.3, 0.1), 0.2, "0.3 - 0.1");
    same(subtract(1.2, 1), 0.2, "1.2 - 1");
    same(subtract(0.1, 0.3), -0.2, "0.1 - 0.3");
    same(subtract(0.5, 0.5), 0, "a zero difference is +0");
    same(subtract(5, 7), -2, "integers");
    same(subtract(Infinity, Infinity), Number.NaN, "Infinity - Infinity");
  });

  it("multiply rounds to the sum of the operands' places", () => {
    same(multiply(1.25, 2), 2.5, "1.25 * 2");
    same(multiply(0.1, 0.2), 0.02, "0.1 * 0.2");
    same(multiply(0.1, 3), 0.3, "0.1 * 3");
    same(multiply(1.1, 1.1), 1.21, "1.1 * 1.1");
    same(multiply(1.005, 100), 100.5, "1.005 * 100");
    same(multiply(4.35, 100), 435, "4.35 * 100");
    same(multiply(-0.1, 0.2), -0.02, "negative");
    same(multiply(-1.5, 0), -0, "a zero product keeps its sign");
    same(multiply(1e-7, 1e-7), 1e-14, "exponent forms");
    same(multiply(1e200, 1e200), Infinity, "overflow");
    same(multiply(Infinity, 0), Number.NaN, "Infinity * 0");
  });

  it("divide keeps full double precision", () => {
    same(divide(1, 3), 1 / 3, "1 / 3");
    same(divide(0.3, 0.1), 2.9999999999999996, "0.3 / 0.1");
    same(divide(1, 0), Infinity, "1 / 0");
    same(divide(-1, 0), -Infinity, "-1 / 0");
    same(divide(0, 0), Number.NaN, "0 / 0");
  });

  it("remainder rounds to the larger operand's places, with the dividend's sign", () => {
    same(remainder(0.3, 0.1), 0, "0.3 % 0.1");
    same(remainder(-0.3, 0.1), -0, "-0.3 % 0.1");
    same(remainder(0.7, 0.2), 0.1, "0.7 % 0.2");
    same(remainder(5.5, 2), 1.5, "5.5 % 2");
    same(remainder(-5.5, 2), -1.5, "-5.5 % 2");
    same(remainder(5.5, -2), 1.5, "5.5 % -2");
    same(remainder(8, 3), 2, "integers");
    same(remainder(1.5, 0), Number.NaN, "zero divisor");
    same(remainder(Infinity, 1.5), Number.NaN, "infinite dividend");
  });

  it("steps 0.1 to 9.9 exactly, where JavaScript drifts from 0.30000000000000004", () => {
    let level = 0;
    let double = 0;
    for (let step = 1; step <= 99; step += 1) {
      level = add(level, 0.1);
      double += 0.1;
      same(level, step / 10, `step ${step}`);
    }
    assert.equal(0.1 + 0.1 + 0.1, 0.30000000000000004);
    assert.equal(double, 9.89999999999998);
  });
});

describe("decimal operations against decimal.js", () => {
  // A seeded generator keeps failures reproducible.
  let seed = 0x2f6b_5d1;
  const random = (): number => {
    seed = seed + 0x6d2b79f5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
  const integer = (low: number, high: number): number => low + Math.floor(random() * (high - low + 1));
  const special = [0, -0, 1, -1, 0.1, 0.2, 0.3, 1.005, 2.675, 4.35, 1e-7, 1.5e-23, 1e21, 2 ** 53, 9.9, 123456789012.345];
  /** Up to 15 significant digits at a decimal exponent from 6 to -25, so values range from integers to exponent forms. */
  const operand = (): number => {
    if (random() < 0.1) return special[integer(0, special.length - 1)]! * (random() < 0.5 ? -1 : 1);
    const digits = Math.floor(random() * 10 ** integer(1, 15));
    const value = Number(`${digits}e${integer(-25, 6)}`);
    return random() < 0.5 ? -value : value;
  };
  Decimal.set({ precision: 1000 });
  const operations = [
    { name: "add", run: add, double: (a: number, b: number) => a + b, exact: (a: Decimal, b: Decimal) => a.plus(b), places: (a: number, b: number) => Math.max(a, b) },
    { name: "subtract", run: subtract, double: (a: number, b: number) => a - b, exact: (a: Decimal, b: Decimal) => a.minus(b), places: (a: number, b: number) => Math.max(a, b) },
    { name: "multiply", run: multiply, double: (a: number, b: number) => a * b, exact: (a: Decimal, b: Decimal) => a.times(b), places: (a: number, b: number) => a + b },
    // decimal.js truncates by default, so the remainder takes the dividend's sign, as JavaScript's `%`.
    { name: "remainder", run: remainder, double: (a: number, b: number) => a % b, exact: (a: Decimal, b: Decimal) => a.mod(b), places: (a: number, b: number) => Math.max(a, b) },
  ];

  for (const operation of operations) {
    it(`${operation.name} gives the double nearest the exact decimal result within 15 significant digits`, () => {
      let decimalDiffers = 0;
      for (let index = 0; index < 20_000; index += 1) {
        const a = operand();
        const b = operand();
        const label = `${operation.name}(${a}, ${b})`;
        const double = operation.double(a, b);
        const left = new Decimal(String(a));
        const right = new Decimal(String(b));
        const places = operation.places(left.decimalPlaces(), right.decimalPlaces());
        // The rule's own limit, computed in doubles as the proposal states it.
        const exact = places > 0 && Math.max(Math.abs(a), Math.abs(b), Math.abs(double)) * 10 ** places < 1e15;
        if (!exact || right.isZero() && operation.name === "remainder") {
          same(operation.run(a, b), double, label);
          continue;
        }
        const result = operation.exact(left, right);
        // A zero result keeps the sign the double result has.
        const expected = result.isZero() ? (double < 0 || Object.is(double, -0) ? -0 : 0) : result.toNumber();
        assert.ok(result.decimalPlaces() <= places, `${label} has more than ${places} places`);
        same(operation.run(a, b), expected, label);
        if (!Object.is(expected, double)) decimalDiffers += 1;
      }
      // The generator must reach results where plain doubles are wrong.
      assert.ok(decimalDiffers > 500, `${operation.name}: only ${decimalDiffers} results differ from doubles`);
    });
  }

  it("divide is JavaScript's double division", () => {
    for (let index = 0; index < 20_000; index += 1) {
      const a = operand();
      const b = operand();
      same(divide(a, b), a / b, `divide(${a}, ${b})`);
    }
  });
});
