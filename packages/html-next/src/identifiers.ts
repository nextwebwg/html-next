// CSS Syntax's ident-start code points, without CSS escapes or the tokenizer's leading-dash
// rules. Continuations add digits only: '-' remains subtraction and '$' marks a reference.
export const IDENTIFIER_START = String.raw`[A-Za-z_\u00B7\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u037D\u037F-\u1FFF\u200C\u200D\u203F\u2040\u2070-\u218F\u2C00-\u2FEF\u3001-\uD7FF\uF900-\uFDCF\uFDF0-\uFFFD\u{10000}-\u{10FFFF}]`;
export const IDENTIFIER = `${IDENTIFIER_START}(?:${IDENTIFIER_START}|[0-9])*`;
const identifier = new RegExp(`^${IDENTIFIER}$`, "u");

export function isIdentifier(value: string): boolean {
  return identifier.test(value);
}
