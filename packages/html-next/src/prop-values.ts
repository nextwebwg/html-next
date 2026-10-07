/**
 * How a component accepts and reflects its props. The live runtime and compiled components share
 * these, so both parse, default and reflect a prop the same way.
 */

import { parseTypedValue, serializeTypedValue } from "./type-system.js";
import type { PropContract, PropType, PropValue } from "./types.js";

/** An invocation's or framework's input, parsed through the prop's type; undefined when it fails. */
export function invocationValue(prop: PropContract, input: unknown, source: "html" | "value" = "html", attributePresent = false, type: PropType | null = prop.type): PropValue | undefined {
  if (input === null) return null;
  // Bare boolean attributes retain HTML presence semantics. Explicit values
  // are invocation strings and must still pass through the declared type.
  const candidate = type === "boolean" && attributePresent && input === "" ? true : input;
  if (type === null) return candidate as PropValue;
  const parsed = parseTypedValue(candidate, type, "$", source);
  return parsed.ok ? parsed.value as PropValue : undefined;
}

/** The `data-<name>` text that records a value. */
export function reflectedPropValue(value: unknown, type: PropType | null): string {
  if (type !== null && parseTypedValue(value, type, "$", "value").ok) {
    return serializeTypedValue(value, type);
  }
  return typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
}

/** A framework's value: undefined returns the prop to its default, and an invalid one is refused. */
export function assignedPropValue(prop: PropContract, input: unknown, type: PropType | null = prop.type): PropValue | undefined {
  if (input !== undefined) return invocationValue(prop, input, "value", false, type);
  return prop.default === undefined ? null : prop.default;
}
