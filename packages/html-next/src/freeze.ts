// The native getter checks Event's internal brand and accepts events from another window.
const eventType = typeof Event === "undefined" ? undefined
  : Object.getOwnPropertyDescriptor(Event.prototype, "type")!.get!;

const eventBrands = new WeakMap<object, boolean>();

export function isNativeEvent(value: unknown): value is Event {
  if (typeof value !== "object" || value === null || eventType === undefined || !("type" in value)) return false;
  const known = eventBrands.get(value);
  if (known !== undefined) return known;
  let accepted = false;
  try { eventType.call(value); accepted = true; } catch { /* The native brand is immutable. */ }
  eventBrands.set(value, accepted);
  return accepted;
}

export function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value) || isNativeEvent(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
