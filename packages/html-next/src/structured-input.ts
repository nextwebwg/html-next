/** Read only literal AST nodes; expressions never execute in attribute input parsing. */
import { parseExpression } from "./expression-parser.js";
import type { ExpressionNode } from "./expression.js";

export function parseHtmlLiteral(
  value: unknown,
  read: (source: string) => ExpressionNode = parseExpression,
): unknown {
  if (typeof value !== "string") return value;
  const literal = (node: ExpressionNode): unknown => {
    switch (node.kind) {
      case "literal": return node.value;
      case "unary": {
        const operand = literal(node.operand);
        if (node.op === "-" && typeof operand === "number") return -operand;
        throw new SyntaxError("Structured attributes must contain literal values.");
      }
      case "array": return node.items.map(literal);
      case "object": return Object.fromEntries(node.pairs.map(({ key, value: item }) => [key, literal(item)]));
      default: throw new SyntaxError("Structured attributes must contain literal values.");
    }
  };
  try { return literal(read(value)); }
  catch { return Symbol.for("html-next.bad-literal"); }
}
