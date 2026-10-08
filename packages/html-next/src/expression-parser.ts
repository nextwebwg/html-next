/** Pure source-to-AST parsing, shared with generated literal input helpers. */
import { IDENTIFIER, IDENTIFIER_START } from "./identifiers.js";
import type { ExpressionNode } from "./expression.js";

type TokenKind = 0 | 1 | 2 | 3 | 4 | 5;

const TOKEN = new RegExp(String.raw`\s*(?:(<=|>=|!=|\^=|\$=|\*=)|(\d+(?:\.\d+|\.(?!${IDENTIFIER_START}|[\d$]))?|\.\d+)(vmin|vmax|rem|px|em|vw|vh|ch|ex|cm|mm|in|pt|pc|q|ms|s|%(?!${IDENTIFIER_START}|[\d$.]|\s*(?:\d|\.\d|\$)))?|("(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*')|(\$\$event(?!${IDENTIFIER_START}|[\d$])|\$?${IDENTIFIER})|([=<>+*/%(),.?:{}[\]\-])|$)`, "uy");
const ESCAPE = /\\([\s\S])/g;

const PRECEDENCE: Readonly<Record<string, number>> = {
  or: 1, and: 2,
  "=": 3, "!=": 3, "^=": 3, "$=": 3, "*=": 3,
  "<": 4, "<=": 4, ">": 4, ">=": 4,
  "+": 5, "-": 5,
  "*": 6, "/": 6, "%": 6,
};

function precedence(token: string | number): number {
  return PRECEDENCE[token as string] ?? 0;
}

function isFunction(name: string): boolean {
  return name === "round"
    || name === "clamp"
    || name === "min"
    || name === "max"
    || name === "abs"
    || name === "default"
    || name === "concat"
    || name === "join"
    || name === "format"
    || name === "formatRange"
    || name === "formatParts";
}

/** Scans directly into the AST: no token array and no token objects. */
export function parseExpression(source: string): ExpressionNode {
  let offset = 0;
  let kind: TokenKind = 0;
  let token: string | number = "";
  let integerToken = false;
  let numericLexeme = "";

  function next(): void {
    const previousKind = kind;
    const previousToken = token;
    const previousIntegerToken = integerToken;
    TOKEN.lastIndex = offset;
    const match = TOKEN.exec(source);
    if (match === null) {
      const character = source.slice(offset).trimStart()[0]!;
      if (character === '"' || character === "'") {
        throw new SyntaxError("Unterminated string literal.");
      }
      throw new SyntaxError(`Unexpected character \`${character}\`.`);
    }
    offset = TOKEN.lastIndex;
    if (previousKind === 4 && previousToken === "." && /^\d+\.\d+/.test(match[2] ?? "")) {
      const digits = /^\d+/.exec(match[2]!)![0];
      offset = match.index + match[0].indexOf(digits) + digits.length;
      kind = 1;
      token = Number(digits);
      integerToken = true;
      numericLexeme = digits;
      return;
    }
    // A dot after a value begins a path segment, even when the segment is an integer.
    if (match[2]?.startsWith(".") && (previousKind === 3 || previousKind === 2
      || previousKind === 1 && previousIntegerToken
      || previousKind === 4 && [")", "]", "}"].includes(String(previousToken)))) {
      offset = match.index + match[0].indexOf(".") + 1;
      kind = 4;
      token = ".";
      return;
    }
    if (match[1] !== undefined || match[6] !== undefined) {
      kind = 4;
      token = match[1] ?? match[6]!;
    } else if (match[2] !== undefined) {
      kind = match[3] === undefined ? 1 : 5;
      token = match[3] === undefined ? Number(match[2]) : `${match[2]}${match[3]}`;
      integerToken = match[3] === undefined && !match[2].includes(".");
      numericLexeme = match[2];
    } else if (match[4] !== undefined) {
      kind = 2;
      token = match[4].slice(1, -1).replace(ESCAPE, "$1");
    } else if (match[5] !== undefined) {
      kind = 3;
      token = match[5]!;
    } else {
      kind = 0;
      token = "";
    }
  }

  function eat(value: string): boolean {
    if (kind !== 4 || token !== value) return false;
    next();
    return true;
  }

  function expect(value: string): void {
    if (!eat(value)) throw new SyntaxError(`Expected \`${value}\`.`);
  }

  function binary(minimum: number): ExpressionNode {
    let left = unary();
    let power = precedence(token);
    while (power >= minimum) {
      const op = token as string;
      next();
      left = { kind: "binary", op, left, right: binary(power + 1) };
      power = precedence(token);
    }
    return left;
  }

  function conditional(): ExpressionNode {
    const test = binary(1);
    if (!eat("?")) return test;
    const consequent = conditional();
    expect(":");
    return { kind: "conditional", test, consequent, alternate: conditional() };
  }

  function unary(): ExpressionNode {
    if (kind === 3 && token === "not") {
      next();
      return { kind: "unary", op: "not", operand: unary() };
    }
    if (eat("-")) return { kind: "unary", op: "-", operand: unary() };

    let object = primary();
    while (kind === 4) {
      if (eat(".")) {
        if ((kind as TokenKind) === 3 && String(token).startsWith("$") ||
          (kind as TokenKind) !== 3 && ((kind as TokenKind) !== 1 || !/^\d+$/.test(numericLexeme))) {
          throw new SyntaxError("Expected a property name after `.`.");
        }
        const numeric = (kind as TokenKind) === 1;
        const key = numeric && Number.isSafeInteger(token) && String(token) === numericLexeme
          ? token : numeric ? numericLexeme : token;
        next();
        object = typeof key === "number"
          ? { kind: "index", object, index: { kind: "literal", value: key } }
          : { kind: "member", object, key };
      } else if (eat("[")) {
        const integerLexeme = (kind as TokenKind) === 1 && /^\d+$/.test(numericLexeme)
          ? numericLexeme : undefined;
        const index = conditional();
        expect("]");
        // A directly written integer uses the same exact key as a dotted integer path.
        // Preserve large and noncanonical object keys instead of rounding them as JS numbers.
        if (integerLexeme !== undefined && index.kind === "literal" && typeof index.value === "number") {
          const key = Number.isSafeInteger(index.value) && String(index.value) === integerLexeme
            ? index.value : integerLexeme;
          object = typeof key === "number"
            ? { kind: "index", object, index: { kind: "literal", value: key } }
            : { kind: "member", object, key };
        } else {
          object = { kind: "index", object, index };
        }
      } else {
        break;
      }
    }
    return object;
  }

  function primary(): ExpressionNode {
    const currentKind = kind;
    const currentToken = token;
    if (currentKind === 5) {
      const written = currentToken as string;
      const unit = /(?:vmin|vmax|rem|px|em|vw|vh|ch|ex|cm|mm|in|pt|pc|q|ms|s|%)$/.exec(written)![0];
      const dimension = unit === "%" ? "percentage" : unit === "ms" || unit === "s" ? "duration" : "length";
      next();
      return { kind: "literal", value: written, dimension };
    }
    if (currentKind === 1 || currentKind === 2) {
      next();
      return { kind: "literal", value: currentToken };
    }
    if (currentKind === 4 && currentToken === "(") {
      next();
      const node = conditional();
      expect(")");
      return node;
    }
    if (currentKind === 4 && currentToken === "{") {
      next();
      const pairs: { key: string; value: ExpressionNode }[] = [];
      if (!eat("}")) {
        do {
          if (token === "}") break;
          if (kind !== 3 && kind !== 2 || kind === 3 && String(token).startsWith("$")) {
            throw new SyntaxError("Object keys must be identifiers or strings.");
          }
          const key = token as string;
          next();
          expect(":");
          pairs.push({ key, value: conditional() });
        } while (eat(","));
        expect("}");
      }
      return { kind: "object", pairs };
    }
    if (currentKind === 4 && currentToken === "[") {
      next();
      const items: ExpressionNode[] = [];
      if (!eat("]")) {
        do {
          if (token === "]") break;
          items.push(conditional());
        } while (eat(","));
        expect("]");
      }
      return { kind: "array", items };
    }
    if (currentKind === 3) {
      const name = currentToken as string;
      next();
      if (name === "true") return { kind: "literal", value: true };
      if (name === "false") return { kind: "literal", value: false };
      if (name === "null") return { kind: "literal", value: null };
      if (token === "(" && isFunction(name)) {
        next();
        const args: ExpressionNode[] = [];
        if (!eat(")")) {
          do args.push(conditional()); while (eat(","));
          expect(")");
        }
        return { kind: "call", fn: name, args };
      }
      if (name === "$$event") return { kind: "id", name };
      // `$name` reads a declaration; a bare name is a keyword literal, never a reference.
      return name.startsWith("$") ? { kind: "id", name: name.slice(1) } : { kind: "literal", value: name, keyword: true };
    }
    throw new SyntaxError("Unexpected end of expression.");
  }

  next();
  const node = conditional();
  if (kind !== 0) throw new SyntaxError("Unexpected trailing input in expression.");
  return node;
}
