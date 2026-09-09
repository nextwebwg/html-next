import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ABSENT,
  UndeclaredName,
  evaluate,
  toAttribute,
  toText,
  truthy,
  type Scope,
  type Value,
} from "../src/expression.js";

function scope(entries: Record<string, Value>): Scope {
  return new Map(Object.entries(entries));
}

describe("expression: reads and absent value", () => {
  it("reads declared identifiers and dotted paths", () => {
    const s = scope({ user: { name: "Ada" }, n: 3 });
    assert.equal(evaluate("user.name", s), "Ada");
    assert.equal(evaluate("n", s), 3);
  });

  it("an undeclared root is a compile error, not absent", () => {
    assert.throws(() => evaluate("mystery", scope({})), UndeclaredName);
  });

  it("a missing property yields the absent value, and access on it stays absent", () => {
    const s = scope({ order: { total: 5 } });
    assert.equal(evaluate("order.error", s), ABSENT);
    assert.equal(evaluate("order.error.message", s), ABSENT); // safe navigation
  });

  it("null literal and out-of-range index behave as absent for access", () => {
    const s = scope({ items: [10, 20] });
    assert.equal(evaluate("items[5]", s), ABSENT);
    assert.equal(evaluate("items[0]", s), 10);
  });
});

describe("expression: truthiness — the empty value of each type is false", () => {
  const s = scope({});
  it("empty values are falsy", () => {
    for (const src of ["false", "null", '""', "0", "[]"]) {
      assert.equal(truthy(evaluate(src, s)), false, `${src} should be falsy`);
    }
    assert.equal(truthy(ABSENT), false);
  });
  it("non-empty values are truthy", () => {
    for (const src of ["true", '"x"', "1", "[1]", "{ a: 1 }"]) {
      assert.equal(truthy(evaluate(src, s)), true, `${src} should be truthy`);
    }
  });
});

describe("expression: typed equality and no coercion", () => {
  const s = scope({});
  it("equality is typed: 1 = \"1\" is false", () => {
    assert.equal(evaluate('1 = "1"', s), false);
    assert.equal(evaluate("1 = 1", s), true);
    assert.equal(evaluate('"a" != "b"', s), true);
  });
  it("arithmetic is numeric only: no string concatenation via +", () => {
    assert.equal(evaluate('"1" + 1', s), ABSENT); // never "11"
    assert.equal(evaluate("2 + 3", s), 5);
  });
  it("arithmetic with an absent operand propagates absent", () => {
    const s2 = scope({ cart: { total: 10 } });
    assert.equal(evaluate("cart.total - cart.discount", s2), ABSENT);
  });
  it("and/or/not return booleans, not operands (no ||-swallows-zero)", () => {
    assert.equal(evaluate("0 or 5", s), true); // boolean, not 5
    assert.equal(evaluate('"" and "x"', s), false);
    assert.equal(evaluate("not 0", s), true);
  });
});

describe("expression: operators, comparison, functions", () => {
  const s = scope({ p: { name: "widget-pro" } });
  it("CSS attribute-selector string operators", () => {
    assert.equal(evaluate('p.name ^= "widget"', s), true);
    assert.equal(evaluate('p.name $= "pro"', s), true);
    assert.equal(evaluate('p.name *= "get-p"', s), true);
    assert.equal(evaluate('p.name ^= "x"', s), false);
  });
  it("ordered comparison and precedence", () => {
    assert.equal(evaluate("(2 + 3) * 2 > 9", scope({})), true);
    assert.equal(evaluate("2 + 3 * 2", scope({})), 8);
  });
  it("the fixed CSS-style function set", () => {
    assert.equal(evaluate("abs(-4)", scope({})), 4);
    assert.equal(evaluate("clamp(0, 12, 10)", scope({})), 10);
    assert.equal(evaluate("min(3, 9, 1)", scope({})), 1);
    assert.equal(evaluate("round(2.6)", scope({})), 3);
  });
});

describe("expression: object/array expressions", () => {
  it("builds structured values with bare keys and expression values", () => {
    const s = scope({ name: "Ada" });
    assert.deepEqual(evaluate("{ label: name, open: true }", s), { label: "Ada", open: true });
    assert.deepEqual(evaluate("[1, 2, name]", s), [1, 2, "Ada"]);
    assert.deepEqual(evaluate("{ 'k': 1, }", s), { k: 1 }); // quoted key + trailing comma
  });
});

describe("expression: serialization", () => {
  it("toText renders absent/null as empty and joins lists", () => {
    assert.equal(toText(ABSENT), "");
    assert.equal(toText(null), "");
    assert.equal(toText(42), "42");
    assert.equal(toText(["a", "b"]), "a b");
  });
  it("toAttribute removes on absent/false, empties on true, else stringifies", () => {
    assert.equal(toAttribute(ABSENT), null);
    assert.equal(toAttribute(false), null);
    assert.equal(toAttribute(true), "");
    assert.equal(toAttribute("x"), "x");
    assert.equal(toAttribute(3), "3");
    assert.equal(toAttribute(["a", "b"]), "a b");
  });
});
