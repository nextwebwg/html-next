/** Closed factory shared with generated checks, including when the compiler is minified. */
export function createEventCheck(
  eventType = typeof Event === "undefined" ? undefined : Object.getOwnPropertyDescriptor(Event.prototype, "type")?.get,
  eventBrands = new WeakMap<object, boolean>(),
): (value: unknown) => value is Event {
  return (value: unknown): value is Event => {
    if (typeof value !== "object" || value === null || eventType === undefined || !("type" in value)) return false;
    let accepted = eventBrands.get(value);
    if (accepted === undefined) {
      try { eventType.call(value); accepted = true; } catch { accepted = false; }
      eventBrands.set(value, accepted);
    }
    return accepted;
  };
}
export const isNativeEvent = /* @__PURE__ */ createEventCheck();

/**
 * A native event or DOM node. Their native getters check that `this` is the platform object
 * itself, so they are stored and read as they are, never proxied or frozen. The node check calls
 * the `nodeType` getter its own prototype chain defines, so a node from another window counts;
 * ordinary data skips it at `in`.
 */
export function isPlatformObject(value: object): boolean {
  if (isNativeEvent(value)) return true;
  if (!("nodeType" in value)) return false;
  for (let prototype = Object.getPrototypeOf(value); prototype !== null; prototype = Object.getPrototypeOf(prototype)) {
    const getter = Object.getOwnPropertyDescriptor(prototype, "nodeType")?.get;
    if (getter !== undefined) {
      try { return typeof getter.call(value) === "number"; } catch { return false; }
    }
  }
  return false;
}

export function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value) || isPlatformObject(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
