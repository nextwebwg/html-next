/**
 * How a component accepts and reflects its props. The live runtime and compiled components share
 * these, so both parse, default and reflect a prop the same way.
 */

import { ABSENT, type Value } from "./expression.js";
import { normalizeType, parseTypedValue, serializeTypedValue, type TypeNode } from "./type-system.js";
import type { PropContract, PropType, PropValue } from "./types.js";

/** An invocation's or framework's input, parsed through the prop's type; undefined when it fails. */
export function invocationValue(prop: PropContract, input: unknown, source: "html" | "value" = "html", attributePresent = false, type: PropType | null = prop.type): PropValue | undefined {
  // Null means not present, so a null input clears the prop to its default (types#null-and-missing-values).
  if (input === null || input === undefined) return prop.default === undefined ? null : prop.default;
  // Bare boolean attributes retain HTML presence semantics. Explicit values
  // are invocation strings and must still pass through the declared type.
  const candidate = type === "boolean" && attributePresent && input === "" ? true : input;
  if (type === null) return candidate as PropValue;
  const parsed = parseTypedValue(candidate, type, "$", source);
  return parsed.ok ? parsed.value as PropValue : undefined;
}

/** The `data-<tag>-prop-<name>` text that records a value. */
export function reflectedPropValue(value: unknown, type: PropType | null): string {
  if (type !== null && parseTypedValue(value, type, "$", "value").ok) {
    return serializeTypedValue(value, type);
  }
  return typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
}

/** A framework's value: null or undefined returns the prop to its default, and an invalid one is refused. */
export function assignedPropValue(prop: PropContract, input: unknown, type: PropType | null = prop.type): PropValue | undefined {
  return invocationValue(prop, input, "value", false, type);
}

export function conformsAtReference(value: Value, type: TypeNode): boolean {
  if (value === null) return true;
  switch (type.kind) {
    case "list":
      return Array.isArray(value);
    case "record":
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    case "union":
      return type.members.some((member) => conformsAtReference(value, member));
    case "constrained":
      return conformsAtReference(value, type.base);
    default:
      return parseTypedValue(value, type, "$", "value").ok;
  }
}

/** Check the destination's immediate type; nested fields are checked when read. */
export function conformsAtDestination(value: Value, type: PropType | TypeNode | null | undefined): boolean {
  // Null, or undefined, means not present: it is never a wrong-typed write (types#null-and-missing-values).
  if (type === undefined || value === ABSENT || value === null || value === undefined) return true;
  if (type === null) return false;
  return conformsAtReference(value, normalizeType(type));
}

