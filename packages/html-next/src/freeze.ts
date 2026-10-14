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

const nodeBrands = new WeakMap<object, boolean>();

/**
 * A native event or DOM node. Their native getters check that `this` is the platform object
 * itself, so they are stored and read as they are, never proxied or frozen. The node check calls
 * the `nodeType` getter its own prototype chain defines, so a node from another window counts.
 */
export function isPlatformObject(value: object): boolean {
  if (isNativeEvent(value)) return true;
  if (!("nodeType" in value)) return false;
  let known = nodeBrands.get(value);
  if (known === undefined) {
    let getter: (() => unknown) | undefined;
    for (let prototype = Object.getPrototypeOf(value); getter === undefined && prototype !== null; prototype = Object.getPrototypeOf(prototype)) {
      getter = Object.getOwnPropertyDescriptor(prototype, "nodeType")?.get;
    }
    known = false;
    try { known = typeof getter?.call(value) === "number"; } catch { /* Not a node: the native getter refused it. */ }
    nodeBrands.set(value, known);
  }
  return known;
}

export function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value) || isPlatformObject(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
