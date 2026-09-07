import { fail } from "./diagnostics.js";
import type { ComponentContract } from "./types.js";

const RESERVED_ELEMENTS = new Set([
  "if",
  "else-if",
  "else",
  "for",
  "with",
  "value",
  "state",
  "computed",
  "data",
]);

const UNSUPPORTED_LITERAL_ATTRIBUTE_PREFIXES = [
  "@",
  "v-",
  "#",
  "on:",
  "use:",
  "transition:",
  "animate:",
] as const;

const UNSAFE_DOM_PROPERTY_NAMES = new Set([
  "innerhtml",
  "outerhtml",
  "srcdoc",
]);

export function isReservedElement(name: string): boolean {
  return RESERVED_ELEMENTS.has(name);
}

export function validateSimplePropExpression(
  expression: string,
  contract: ComponentContract,
  source: string,
): string {
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(expression) || contract.props[expression] === undefined) {
    fail("H7T003", `\`${expression}\` is not a declared MVP prop expression.`, source);
  }
  return expression;
}

export function validateLiteralAttributeName(name: string, source: string): string {
  const lowerName = name.toLowerCase();
  if (
    lowerName.startsWith("on") ||
    UNSUPPORTED_LITERAL_ATTRIBUTE_PREFIXES.some((prefix) => lowerName.startsWith(prefix))
  ) {
    fail(
      "H7T010",
      `Literal attribute \`${name}\` uses target-framework directive syntax that is not supported by the MVP.`,
      source,
    );
  }
  return name;
}

export function validateMvpDomProperty(name: string, source: string): string {
  const lowerName = name.toLowerCase();
  if (lowerName.startsWith("on") || UNSAFE_DOM_PROPERTY_NAMES.has(lowerName)) {
    fail("H7T007", `Dynamic ${name} requires a future trusted-content type.`, source);
  }
  return name;
}
