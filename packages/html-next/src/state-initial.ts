/**
 * What a null write to a state stores (https://nextwebwg.org/declarative-components/types#null-and-missing-values).
 * A state with a `value` goes back to it, as a reflected property returns to its default when its
 * attribute is removed; a state without one holds null. A field below a state goes back to its value in
 * the state's declared `value`, or to null where that has none. `host.reset` writes the same value. The
 * framework targets carry `STATE_INITIAL_SOURCE`, the same function as source.
 */

/** A fresh copy of the declared `value` at `keys`: an object or list is never the declared one. */
export function initialAt(initial: unknown, keys: readonly PropertyKey[]): unknown {
  let value = initial;
  for (const key of keys) {
    if (value === null || typeof value !== "object" || !Object.hasOwn(value, key)) return null;
    value = (value as Record<PropertyKey, unknown>)[key];
  }
  return value === undefined ? null : value !== null && typeof value === "object" ? structuredClone(value) : value;
}

export const STATE_INITIAL_SOURCE = `
/** A fresh copy of a state's declared value at \`keys\`, or null where it has none. */
function initialAt(initial: unknown, keys: readonly PropertyKey[]): unknown {
  let value = initial;
  for (const key of keys) {
    if (value === null || typeof value !== "object" || !Object.hasOwn(value, key)) return null;
    value = (value as Record<PropertyKey, unknown>)[key];
  }
  return value === undefined ? null : value !== null && typeof value === "object" ? structuredClone(value) : value;
}
`;
