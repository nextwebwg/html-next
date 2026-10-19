import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { parseExpression } from "../src/expression-parser.js";
import { parseHtmlLiteral } from "../src/structured-input.js";
import type { ExpressionNode } from "../src/expression.js";

// The pre-existing AST literal reader is the compatibility oracle; no expression is evaluated.
function previous(source: string): unknown {
  const read = (node: ExpressionNode): unknown => {
    if (node.kind === "literal") return node.value;
    if (node.kind === "unary" && node.op === "-") { const value = read(node.operand); if (typeof value === "number") return -value; }
    if (node.kind === "array") return node.items.map(read);
    if (node.kind === "object") return Object.fromEntries(node.pairs.map(({ key, value }) => [key, read(value)]));
    throw new SyntaxError();
  };
  try { return read(parseExpression(source)); } catch { return Symbol.for("html-next.bad-literal"); }
}

describe("standalone attribute literal reader", () => {
  it("preserves existing literal spelling, escapes, keys, units and rejection semantics", () => {
    const atoms = ["true", "false", "null", "0", "-0", "-2.5", ".25", "1.", "--2", "(-2)", "solid", "not", "and", "20px", "2.5ms", "50%", "-2px", "'single'", '"double"', String.raw`'a\nb\'c'`, "$value", "2 + 3", "concat('a', 'b')", "not true", "1e2", "", "undefined", "$$event", "[1,]", "{ x: 1, }", "{ '__proto__': 7 }", "{ x: 1, x: 2 }"];
    for (const atom of atoms) {
      for (const source of [atom, `[${atom}]`, `{ key: ${atom}, 'other key': [${atom},], 日本: false, }`]) {
        assert.deepEqual(parseHtmlLiteral(source), previous(source), source);
      }
    }
    for (const source of ["[,1]", "[1,,2]", "{1: true}", "{$key: 1}", "[null].length", "{ x: 1 }.x", "{x:}", "{ x 1 }", "[1", "'unterminated", "[1] trailing", "[1;2]", "[1] + [2]"]) {
      assert.equal(parseHtmlLiteral(source), Symbol.for("html-next.bad-literal"), source);
    }
  });

  it("does not parse property values or mutate object prototypes", () => {
    const value = { name: "Coffee" };
    assert.equal(parseHtmlLiteral(value), value);
    const result = parseHtmlLiteral("{ '__proto__': { polluted: true } }") as Record<string, unknown>;
    assert.equal(Object.getPrototypeOf(result), Object.prototype);
    assert.equal(Object.hasOwn(result, "__proto__"), true);
    assert.equal(Reflect.get(Object.prototype, "polluted"), undefined);
  });
});
