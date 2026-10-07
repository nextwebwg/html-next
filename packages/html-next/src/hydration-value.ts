import { fail } from "./diagnostics.js";
import { ABSENT, NONCONFORMING } from "./expression.js";

/** Tagged values keep missing values distinct from null and from authored objects. */
export type HydrationValue =
  | readonly ["value", string | number | boolean | null]
  | readonly ["array", readonly HydrationValue[]]
  | readonly ["object", readonly (readonly [string, HydrationValue])[]]
  | readonly ["reference", number]
  | readonly ["absent" | "nonconforming" | "undefined" | "negative-zero"];

export function encodeHydrationValue(value: unknown, ancestors = new Set<object>(), references = new Map<object, number>()): HydrationValue {
  if (value === ABSENT) return ["absent"];
  if (value === NONCONFORMING) return ["nonconforming"];
  if (value === undefined) return ["undefined"];
  if (Object.is(value, -0)) return ["negative-zero"];
  if (value === null || typeof value === "string" || typeof value === "boolean" ||
    typeof value === "number" && Number.isFinite(value)) return ["value", value];
  if (typeof value !== "object" || ancestors.has(value) ||
    !Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null ||
    Object.getOwnPropertySymbols(value).length > 0) {
    fail("HR010", "Rendered component values must be serializable data, not cyclic, opaque, or executable values.");
  }
  const reference = references.get(value);
  if (reference !== undefined) return ["reference", reference];
  references.set(value, references.size);
  ancestors.add(value);
  try {
    return Array.isArray(value)
      ? ["array", Array.from(value, (item) => encodeHydrationValue(item, ancestors, references))]
      : ["object", Object.entries(value).map(([name, item]) => [name, encodeHydrationValue(item, ancestors, references)] as const)];
  } finally { ancestors.delete(value); }
}

export function decodeHydrationValue(input: unknown, references: object[] = []): unknown {
  if (!Array.isArray(input)) fail("HR010", "Malformed rendered component value.");
  const [kind, value] = input;
  if (input.length === 1) {
    if (kind === "absent") return ABSENT;
    if (kind === "nonconforming") return NONCONFORMING;
    if (kind === "undefined") return undefined;
    if (kind === "negative-zero") return -0;
  }
  if (input.length === 2) {
    if (kind === "reference" && Number.isInteger(value) && value >= 0 && value < references.length) return references[value];
    if (kind === "value" && (value === null || typeof value === "string" || typeof value === "boolean" ||
      typeof value === "number" && Number.isFinite(value))) return value;
    if (kind === "array" && Array.isArray(value)) {
      const array: unknown[] = [];
      references.push(array);
      for (const item of value) array.push(decodeHydrationValue(item, references));
      return array;
    }
    if (kind === "object" && Array.isArray(value)) {
      const object = {};
      references.push(object);
      const names = new Set<string>();
      for (const entry of value) {
        if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string" || names.has(entry[0])) {
          fail("HR010", "Malformed rendered component object.");
        }
        names.add(entry[0]);
        Object.defineProperty(object, entry[0], { value: decodeHydrationValue(entry[1], references),
          enumerable: true, writable: true, configurable: true });
      }
      return object;
    }
  }
  fail("HR010", "Malformed rendered component value.");
}
