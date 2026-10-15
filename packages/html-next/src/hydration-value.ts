import { fail } from "./diagnostics.js";
import { ABSENT, NONCONFORMING } from "./expression.js";

/**
 * Tagged values keep missing values distinct from null and from authored objects. A `json` value is
 * plain data written as itself: an array or object holding strings, booleans, null, finite numbers
 * other than -0, and arrays and objects of the same, none of which occurs anywhere else in the value.
 */
export type HydrationValue =
  | readonly ["value", string | number | boolean | null]
  | readonly ["array", readonly HydrationValue[]]
  | readonly ["object", readonly (readonly [string, HydrationValue])[]]
  | readonly ["json", object]
  | readonly ["reference", number]
  | readonly ["absent" | "nonconforming" | "undefined" | "negative-zero"];

const plainObject = (value: object): boolean => (Array.isArray(value) ||
  Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) && Object.getOwnPropertySymbols(value).length === 0;

/** How many times each object occurs in a value, counting each object's contents once. */
function occurrences(value: unknown, counts: Map<object, number>): void {
  if (typeof value !== "object" || value === null) return;
  const count = (counts.get(value) ?? 0) + 1;
  counts.set(value, count);
  if (count === 1) for (const item of Object.values(value)) occurrences(item, counts);
}

/** Whether an array's or object's contents are plain data occurring nowhere else, which JSON writes as they are. */
function plainContents(value: object, counts: ReadonlyMap<object, number>, known: Map<object, boolean>): boolean {
  let plain = known.get(value);
  if (plain !== undefined) return plain;
  known.set(value, false);
  plain = plainObject(value);
  // Index by index, so a hole stays the undefined the tagged form keeps, not JSON's null.
  const items = Array.isArray(value) ? Array.from(value) : Object.values(value);
  for (let index = 0; plain && index < items.length; index += 1) {
    const item = items[index];
    plain = item === null || typeof item === "string" || typeof item === "boolean" ||
      typeof item === "number" && Number.isFinite(item) && !Object.is(item, -0) ||
      typeof item === "object" && counts.get(item) === 1 && plainContents(item, counts, known);
  }
  known.set(value, plain);
  return plain;
}

export function encodeHydrationValue(value: unknown): HydrationValue {
  const counts = new Map<object, number>();
  occurrences(value, counts);
  return encode(value, new Set(), new Map(), counts, new Map());
}

function encode(value: unknown, ancestors: Set<object>, references: Map<object, number>,
  counts: ReadonlyMap<object, number>, known: Map<object, boolean>): HydrationValue {
  if (value === ABSENT) return ["absent"];
  if (value === NONCONFORMING) return ["nonconforming"];
  if (value === undefined) return ["undefined"];
  if (Object.is(value, -0)) return ["negative-zero"];
  if (value === null || typeof value === "string" || typeof value === "boolean" ||
    typeof value === "number" && Number.isFinite(value)) return ["value", value];
  if (typeof value !== "object" || ancestors.has(value) || !plainObject(value)) {
    fail("HR010", "Rendered component values must be serializable data, not cyclic, opaque, or executable values.");
  }
  const reference = references.get(value);
  if (reference !== undefined) return ["reference", reference];
  references.set(value, references.size);
  // The object itself may occur again, as a reference to it.
  if (plainContents(value, counts, known)) return ["json", value];
  ancestors.add(value);
  try {
    return Array.isArray(value)
      ? ["array", Array.from(value, (item) => encode(item, ancestors, references, counts, known))]
      : ["object", Object.entries(value).map(([name, item]) => [name, encode(item, ancestors, references, counts, known)] as const)];
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
    // Parsed from JSON, so it is plain data already.
    if (kind === "json" && typeof value === "object" && value !== null) {
      references.push(value);
      return value;
    }
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
