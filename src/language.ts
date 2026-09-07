import { fail } from "./diagnostics.js";
import type { ComponentContract } from "./types.js";

export const CONTRACT_TYPE = "application/html7-contract+json";

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

