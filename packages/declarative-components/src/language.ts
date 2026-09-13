import { fail } from "./diagnostics.js";
import { hasExecutableUrl, isUrlAttribute } from "./sanitize.js";
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

const UNSAFE_DEFINITION_ELEMENTS = new Set([
  "base",
  "embed",
  "link",
  "meta",
  "object",
  "script",
  "style",
]);

export function isReservedElement(name: string): boolean {
  return RESERVED_ELEMENTS.has(name);
}

export function validateDefinitionElementName(name: string, source: string): string {
  if (UNSAFE_DEFINITION_ELEMENTS.has(name.toLowerCase())) {
    fail("HT009", `<${name}> is not permitted in rendered component markup.`, source);
  }
  return name;
}

export function validateSimplePropExpression(
  expression: string,
  contract: ComponentContract,
  source: string,
): string {
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(expression) || contract.props[expression] === undefined) {
    fail("HT003", `\`${expression}\` is not a declared component expression.`, source);
  }
  return expression;
}

export function validateLiteralAttributeName(
  name: string,
  source: string,
  value = "",
): string {
  const lowerName = name.toLowerCase();
  if (
    lowerName.startsWith("on") ||
    UNSUPPORTED_LITERAL_ATTRIBUTE_PREFIXES.some((prefix) => lowerName.startsWith(prefix))
  ) {
    fail(
      "HT010",
      `Literal attribute \`${name}\` uses target-framework directive syntax that is not supported.`,
      source,
    );
  }
  if (lowerName === "srcdoc") {
    fail("HT007", "Literal `srcdoc` is not permitted in a component definition.", source);
  }
  if (isUrlAttribute(lowerName) && hasExecutableUrl(value)) {
    fail("HT007", `Literal \`${name}\` contains an executable URL.`, source);
  }
  return name;
}

export function validateMvpDomProperty(name: string, source: string): string {
  const lowerName = name.toLowerCase();
  if (lowerName.startsWith("on") || UNSAFE_DOM_PROPERTY_NAMES.has(lowerName)) {
    fail("HT007", `Dynamic ${name} requires a future trusted-content type.`, source);
  }
  return name;
}
