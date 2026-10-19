/** Attribute literals share expression spelling, without loading an expression parser/evaluator. */
import { IDENTIFIER, IDENTIFIER_START } from "./identifiers.js";

const LITERAL_TOKEN = new RegExp(String.raw`\s*(?:("(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*')|(\d+(?:\.\d+|\.(?!${IDENTIFIER_START}|[\d$]))?|\.\d+)(vmin|vmax|rem|px|em|vw|vh|ch|ex|cm|mm|in|pt|pc|q|ms|s|%(?!${IDENTIFIER_START}|[\d$.]|\s*(?:\d|\.\d|\$)))?|(${IDENTIFIER})|([\[\]{},:()\-])|$)`, "uy");
const LITERAL_ESCAPE = /\\([\s\S])/g;

export function parseHtmlLiteral(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const source = value;
  let offset = 0;
  let kind = "";
  let token: string | number = "";
  const invalid: () => never = () => { throw new SyntaxError("Structured attributes must contain literal values."); };
  const next = (): void => {
    LITERAL_TOKEN.lastIndex = offset;
    const match = LITERAL_TOKEN.exec(source);
    if (match === null) invalid();
    offset = LITERAL_TOKEN.lastIndex;
    if (match[1] !== undefined) { kind = "string"; token = match[1].slice(1, -1).replace(LITERAL_ESCAPE, "$1"); }
    else if (match[2] !== undefined) {
      kind = match[3] === undefined ? "number" : "dimension";
      token = match[3] === undefined ? Number(match[2]) : match[2] + match[3];
    } else if (match[4] !== undefined) { kind = "keyword"; token = match[4]; }
    else { kind = match[5] === undefined ? "end" : "punctuation"; token = match[5] ?? ""; }
  };
  const eat = (expected: string): boolean => {
    if (kind !== "punctuation" || token !== expected) return false;
    next();
    return true;
  };
  const expect = (expected: string): void => { if (!eat(expected)) invalid(); };
  const read = (): unknown => {
    if (eat("-")) { const operand = read(); return typeof operand === "number" ? -operand : invalid(); }
    if (eat("(")) { const item = read(); expect(")"); return item; }
    if (eat("[")) {
      const items: unknown[] = [];
      if (!eat("]")) {
        do { if (kind === "punctuation" && token === "]") break; items.push(read()); } while (eat(","));
        expect("]");
      }
      return items;
    }
    if (eat("{")) {
      const pairs: [string, unknown][] = [];
      if (!eat("}")) {
        do {
          if (kind === "punctuation" && token === "}") break;
          if (kind !== "keyword" && kind !== "string") invalid();
          const key = String(token);
          next(); expect(":"); pairs.push([key, read()]);
        } while (eat(","));
        expect("}");
      }
      return Object.fromEntries(pairs);
    }
    const current = token;
    if (kind === "number" || kind === "string" || kind === "dimension") { next(); return current; }
    if (kind === "keyword" && current !== "not") {
      next();
      return current === "true" ? true : current === "false" ? false : current === "null" ? null : current;
    }
    return invalid();
  };
  try {
    next();
    const result = read();
    if (kind !== "end") invalid();
    return result;
  } catch { return Symbol.for("html-next.bad-literal"); }
}
