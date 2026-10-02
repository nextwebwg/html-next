import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  ABSENT,
  UndeclaredName,
  checkExpression,
  compileExpression,
  evaluate,
  evaluateCompiled,
  getWritablePath,
  NONCONFORMING,
  toAttribute,
  toText,
  typeCheckedDependencies,
  truthy,
  type Scope,
  type Value,
} from "../src/expression.js";

describe("expression: compilation", () => {
  it("uses dollar-prefixed references and dotted or bracketed list indexes", () => {
    const compiled = compileExpression("$items.0.name = 'Ada' and $items.1.name != null");
    assert.deepEqual(compiled.dependencies, ["items.0.name", "items.1.name"]);
    const s = scope({ items: [{ name: "Ada" }, { name: "Bea" }] });
    assert.equal(evaluate("$items.0.name", s), "Ada");
    assert.equal(evaluate("$items.1.name", s), "Bea");
    assert.deepEqual(getWritablePath("$items.0.name", new Set(["items"])), ["items", 0, "name"]);
    assert.equal(evaluate("$groups.0.1.name", scope({ groups: [[{ name: "A" }, { name: "B" }]] })), "B");
    assert.deepEqual(getWritablePath("$groups.0.1.name", new Set(["groups"])), ["groups", 0, 1, "name"]);
    assert.equal(evaluate("$items[0].name", s), "Ada");
    assert.equal(evaluate("$items[1].name", s), "Bea");
    assert.equal(evaluate("$groups[0][1].name", scope({ groups: [[{ name: "A" }, { name: "B" }]] })), "B");
    assert.deepEqual(compileExpression("$items[0].name").dependencies, ["items.0.name"]);
    assert.deepEqual(getWritablePath("$items[0].name", new Set(["items"])), ["items", 0, "name"]);
    assert.doesNotThrow(() => checkExpression("items[0].name"));
    assert.equal(evaluate("$items[-0].name", s), "Ada");
  });
  it("preserves the exact spelling of numeric object keys", () => {
    const byId = {
      "9007199254740992": { name: "wrong" },
      "9007199254740993": { name: "right" },
      "01": { name: "leading zero" },
    };
    assert.equal(evaluate("$byId.9007199254740993.name", scope({ byId })), "right");
    assert.equal(evaluate("$byId.01.name", scope({ byId })), "leading zero");
    assert.equal(evaluate("$byId[9007199254740993].name", scope({ byId })), "right");
    assert.equal(evaluate("$byId[01].name", scope({ byId })), "leading zero");
    assert.deepEqual(compileExpression("$byId.9007199254740993.name").dependencies, ["byId.9007199254740993.name"]);
    assert.deepEqual(compileExpression("$byId[9007199254740993].name").dependencies, ["byId.9007199254740993.name"]);
    assert.deepEqual(getWritablePath("$byId.9007199254740993.name", new Set(["byId"])),
      ["byId", "9007199254740993", "name"]);
  });
  it("exposes a serializable AST and normalized static dependencies", () => {
    const compiled = compileExpression(
      "$cart.items.0.name = $selected.name and $flags[$mode]",
    );

    assert.equal(compiled.ast.kind, "binary");
    assert.deepEqual(compiled.dependencies, [
      "cart.items.0.name",
      "flags",
      "mode",
      "selected.name",
    ]);
    assert.deepEqual(JSON.parse(JSON.stringify(compiled.ast)), compiled.ast);
  });

  it("checks the declared type of every concat argument", () => {
    const compiled = compileExpression("concat(result.value.label, '/', result.value.note)");
    assert.deepEqual(compiled.dependencies, ["result.value.label", "result.value.note"]);
    assert.deepEqual(typeCheckedDependencies(compiled), ["result.value.label", "result.value.note"]);
    assert.deepEqual(typeCheckedDependencies("result.value.label"), ["result.value.label"]);
  });

  it("accepts only state-rooted access paths as writable bindings", () => {
    assert.deepEqual(getWritablePath("$form.contacts.0.email", new Set(["form"])), [
      "form",
      "contacts",
      0,
      "email",
    ]);
    assert.equal(getWritablePath("$props.value", new Set(["form"])), undefined);
    assert.deepEqual(getWritablePath("$form.contacts[$index]", new Set(["form"])), [
      "form",
      "contacts",
      { kind: "index", expression: { kind: "id", name: "index" } },
    ]);
    assert.equal(getWritablePath("$form.total + 1", new Set(["form"])), undefined);
  });
});

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
    const s = scope({ items: [10, 20, null], record: { value: null } });
    assert.equal(evaluate("$items.5", s), ABSENT);
    assert.equal(evaluate("$items.0", s), 10);
    assert.equal(evaluate("$items.2", s), null);
    assert.equal(evaluate("record.value", s), null);
  });

  it("reads a list's or string's length as its count, as Vue conversion does", () => {
    const s = scope({ validation: { issues: [] as Value[] }, cart: { items: [1, 2] }, name: "Ada", record: { length: 7 } });
    assert.equal(evaluate("not validation.issues.length", s), true);
    assert.equal(evaluate("cart.items.length", s), 2);
    assert.equal(evaluate("name.length", s), 3);
    assert.equal(evaluate("record.length", s), 7);
  });
});

describe("expression: truthiness — the empty value of each type is false", () => {
  const s = scope({});
  it("empty values are falsy", () => {
    for (const src of ["false", "null", '""', "0", "[]", "{}"]) {
      assert.equal(truthy(evaluate(src, s)), false, `${src} should be falsy`);
    }
    assert.equal(truthy(ABSENT), false);
  });

  it("ignores inherited properties when deciding whether a record is empty", () => {
    const inherited = Object.create({ inherited: true }) as Record<string, never>;
    assert.equal(truthy(inherited), false);
  });
  it("treats a present native error as a failure, even though its message is non-enumerable", () => {
    assert.equal(truthy(new TypeError("offline") as unknown as Value), true);
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
    assert.equal(evaluate("8%3", s), 2);
    assert.equal(evaluate("8% 3", s), 2);
    assert.equal(evaluate("8 % 3", s), 2);
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

describe("expression: conditional selection", () => {
  it("has lower precedence than or and associates to the right", () => {
    const s = scope({ a: false, b: true, c: false });
    assert.equal(evaluate("a or b ? 'yes' : 'no'", s), "yes");
    assert.equal(evaluate("a ? 1 : c ? 2 : 3", s), 3);
    assert.equal(evaluate("a ? b ? 1 : 2 : 3", s), 3);
  });

  it("evaluates only the selected branch and preserves its value", () => {
    assert.equal(evaluate("true ? 0 : missing", scope({})), 0);
    assert.equal(evaluate("false ? missing : null", scope({})), null);
    assert.equal(evaluate("[] ? 1 : 'empty'", scope({})), "empty");
    assert.deepEqual(evaluate("true ? [1, 2] : []", scope({})), [1, 2]);
  });

  it("works in nested expression positions and tracks every dependency", () => {
    const s = scope({ flag: true, value: 4, fallback: 9 });
    assert.deepEqual(evaluate("{ selected: flag ? value : fallback }", s), { selected: 4 });
    assert.equal(evaluate("[10, 20][flag ? 0 : 1]", s), 10);
    assert.equal(evaluate("max(flag ? value : fallback, 2)", s), 4);
    assert.deepEqual(compileExpression("flag ? value : fallback").dependencies, ["fallback", "flag", "value"]);
    assert.equal(getWritablePath("flag ? value : fallback", new Set(["value"])), undefined);
  });

  it("rejects incomplete conditionals", () => {
    assert.throws(() => checkExpression("flag ? value"), /Expected `:`/);
    assert.throws(() => checkExpression("flag ? value :"), /Unexpected end of expression/);
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

  it("assembles scalar text and joins typed lists", () => {
    assert.equal(evaluate("concat('row-', 'alpha', '-', 2)", s), "row-alpha-2");
    assert.equal(evaluate("concat(42, '%')", s), "42%");
    assert.equal(evaluate("concat(true)", s), "true");
    assert.equal(evaluate("join(['red', null, 'blue'], ', ')", s), "red, , blue");
    assert.equal(evaluate("join([], ', ')", s), "");
    assert.equal(evaluate("join([1, 'two'], ', ')", s), ABSENT);
    assert.equal(evaluate("42 + '%'", s), ABSENT);
    assert.equal(evaluate("concat()", s), ABSENT);
    assert.equal(evaluate("join(['red'], 1)", s), ABSENT);
    assert.throws(() => checkExpression("format('%s', 1)"), SyntaxError);
  });
  it("uses absent-or-null fallback without evaluating an unused arm", () => {
    const data = scope({ data: { present: 0 } });
    assert.equal(evaluate("default($data.missing, 5)", data), 5);
    assert.equal(evaluate("default(null, 5)", data), 5);
    assert.equal(evaluate("default($data.present, 5)", data), 0);
    assert.equal(evaluate("default(false, true)", data), false);
    assert.equal(evaluate("default('', 'fallback')", data), "");
    assert.equal(evaluate("default(2, $undeclared)", data), 2);
    assert.equal(evaluateCompiled(compileExpression("concat($data.missing)"), data), ABSENT);
    assert.equal(evaluateCompiled(compileExpression("default(round(8px, $step), 1px)"), {
      get: (name) => name === "step" ? "0px" : undefined,
      typeOfPath: (name) => name === "step" ? "length" : undefined,
    }), NONCONFORMING);
  });
  it("ordered comparison and precedence", () => {
    assert.equal(evaluate("(2 + 3) * 2 > 9", scope({})), true);
    assert.equal(evaluate("2 + 3 * 2", scope({})), 8);
    assert.equal(evaluate("8 / 4 / 2", scope({})), 1);
  });
  it("the fixed CSS-style function set", () => {
    assert.equal(evaluate("abs(-4)", scope({})), 4);
    assert.equal(evaluate("clamp(0, 12, 10)", scope({})), 10);
    assert.equal(evaluate("clamp(10, 5, 0)", scope({})), 10);
    assert.equal(evaluate("min(3, 9, 1)", scope({})), 1);
    assert.equal(evaluate("round(2.6)", scope({})), 3);
    assert.equal(evaluate("round(2.6, 0.5)", scope({})), 2.5);
    assert.equal(evaluate("round(-2.5)", scope({})), -2);
  });
  it("calculates with dimensional literals only in their written unit", () => {
    const empty = scope({});
    assert.equal(evaluate("round(8.8px)", empty), "9px");
    assert.equal(evaluate("round(25.5%)", empty), "26%");
    assert.equal(evaluate("round(1.6s)", empty), "2s");
    assert.equal(evaluate("round(1600ms)", empty), "1600ms");
    assert.equal(evaluate("round(8.8px, 0.5px)", empty), "9px");
    assert.equal(evaluate("min(1px, 2px)", empty), "1px");
    assert.equal(evaluate("max(200ms, 500ms)", empty), "500ms");
    assert.equal(evaluate("clamp(0px, 5px, 3px)", empty), "3px");
    assert.equal(evaluate("abs(-2rem)", empty), "2rem");
    assert.equal(evaluate("min(1in, 100px)", empty), ABSENT);
    assert.equal(evaluate("round(8.8px, 1rem)", empty), ABSENT);
    assert.equal(evaluate("round(8px, 0px)", empty), ABSENT);
  });
  it("preserves written units when arithmetic combines a dimension with a number", () => {
    const empty = scope({});
    assert.equal(evaluate("100px / 100", empty), "1px");
    assert.equal(evaluate("2.5 * 100px", empty), "250px");
    assert.equal(evaluate("100px * 0.25", empty), "25px");
    assert.equal(evaluate("200ms / 2", empty), "100ms");
    assert.equal(evaluate("1.5s + 0.5s", empty), "2s");
    assert.equal(evaluate("25% * 0.5", empty), "12.5%");
    assert.equal(evaluate("1px + 2px", empty), "3px");
    assert.equal(evaluate("3px - 1px", empty), "2px");
    assert.equal(evaluate("round(8.8px / 2)", empty), "4px");
    assert.equal(evaluate("($flag ? 1px : 2px) * 2", scope({ flag: true })), "2px");
    assert.equal(evaluate("($flag ? 1px : 2px) * 2", scope({ flag: false })), "4px");
    assert.equal(evaluate("1px + 1", empty), ABSENT);
    assert.equal(evaluate("1px + 1ms", empty), ABSENT);
    assert.equal(evaluate("1px + 1rem", empty), ABSENT);
    assert.equal(evaluate("1px * 1px", empty), ABSENT);
    assert.equal(evaluate("1px / 1px", empty), ABSENT);
    assert.equal(evaluate("1 / 1px", empty), ABSENT);
    assert.equal(evaluate("1px / 0", empty), ABSENT);
    assert.equal(evaluateCompiled(compileExpression("1px + 1rem"), empty), NONCONFORMING);
    assert.equal(evaluateCompiled(compileExpression("1px / 0"), empty), NONCONFORMING);
  });
  it("requires a dimension declaration for referenced dimensional strings", () => {
    const values = new Map<string, Value>([["width", "8.8px"], ["label", "8.8px"]]);
    const typed: Scope = {
      get: (name) => values.get(name),
      typeOfPath: (path) => path === "width" ? "length" : undefined,
    };
    assert.equal(evaluate("round($width)", typed), "9px");
    assert.equal(evaluate("round($label)", typed), ABSENT);
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

describe("expression: syntax diagnostics", () => {
  it("retains the public diagnostics for malformed input", () => {
    assert.throws(() => checkExpression("'open"), /Unterminated string literal\./);
    assert.throws(() => checkExpression("value."), /Expected a property name after `\.`\./);
    assert.throws(() => checkExpression("{ 1: true }"), /Object keys must be identifiers or strings\./);
    assert.throws(() => checkExpression("(1"), /Expected `\)`\./);
    assert.throws(() => checkExpression("1 @ 2"), /Unexpected character `@`\./);
    assert.throws(() => checkExpression("1 2"), /Unexpected trailing input in expression\./);
  });

  it("parses decimal and escaped string literals without JavaScript evaluation", () => {
    assert.equal(evaluate(".5 + 1.", scope({})), 1.5);
    assert.equal(evaluate("'it\\'s'", scope({})), "it's");
    assert.throws(() => checkExpression("1.2.3"), SyntaxError);
  });
});

describe("expression: serialization", () => {
  it("toText renders absent/null as empty and joins lists", () => {
    assert.equal(toText(ABSENT), "");
    assert.equal(toText(null), "");
    assert.equal(toText(42), "42");
    assert.equal(toText(["a", "b"]), "a b");
    assert.equal(toText(["", "b"]), " b");
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
