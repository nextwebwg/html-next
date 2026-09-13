import { fail } from "./diagnostics.js";
import { hasExecutableUrl, isUrlAttribute } from "./sanitize.js";
import type { ComponentContract } from "./types.js";

const RESERVED_ELEMENT_RE = /^(?:if|else-if|else|for|with|value|state|computed|data)$/;
const UNSUPPORTED_LITERAL_ATTRIBUTE_RE = /^(?:@|v-|#|on:|use:|transition:|animate:)/;
const UNSAFE_DOM_PROPERTY_RE = /^(?:innerhtml|outerhtml|srcdoc)$/;
const UNSAFE_DEFINITION_ELEMENT_RE = /^(?:base|embed|link|meta|object|script|style)$/;

export function isReservedElement(name: string): boolean {
  return RESERVED_ELEMENT_RE.test(name);
}

export function validateDefinitionElementName(name: string, source: string): string {
  if (UNSAFE_DEFINITION_ELEMENT_RE.test(name.toLowerCase())) {
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
    UNSUPPORTED_LITERAL_ATTRIBUTE_RE.test(lowerName)
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
  if (lowerName.startsWith("on") || UNSAFE_DOM_PROPERTY_RE.test(lowerName)) {
    fail("HT007", `Dynamic ${name} requires a future trusted-content type.`, source);
  }
  return name;
}
