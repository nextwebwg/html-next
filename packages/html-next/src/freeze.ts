// The native getter checks Event's internal brand and accepts events from another window.
const eventType = typeof Event === "undefined" ? undefined
  : Object.getOwnPropertyDescriptor(Event.prototype, "type")!.get!;

export function isNativeEvent(value: unknown): value is Event {
  if (typeof value !== "object" || value === null || eventType === undefined || !("type" in value)) return false;
  try {
    eventType.call(value);
    return true;
  } catch {
    return false;
  }
}

export function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value) || isNativeEvent(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
