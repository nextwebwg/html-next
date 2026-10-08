/** Shared controller namespaces; each framework supplies its own tracked accessors. */
export const CONTROLLER_STATE_SOURCE = `
interface ControllerStateAccess { readonly get: () => unknown; readonly set: (value: unknown) => void; }
interface ControllerNamespaces {
  readonly state: Readonly<Record<string, ControllerStateAccess>>;
  readonly computed: Readonly<Record<string, () => unknown>>;
  readonly data?: Readonly<Record<string, () => unknown>>;
  readonly acceptsState?: (name: string, keys: readonly string[], value: unknown) => boolean;
  readonly changed?: (name: string) => void;
}

function controllerNamespaces(options: ControllerNamespaces, source: string): {
  state: Record<string, unknown>; data: Readonly<Record<string, unknown>>;
} {
  const reported = new Set<string>();
  const nested = new WeakMap<object, Map<string, object>>();
  const eventType = typeof Event === "undefined" ? undefined : Object.getOwnPropertyDescriptor(Event.prototype, "type")!.get!;
  const eventBrands = new WeakMap<object, boolean>();
  const nativeEvent = (value: object): boolean => {
    if (!("type" in value) || eventType === undefined) return false;
    const known = eventBrands.get(value);
    if (known !== undefined) return known;
    let accepted = false;
    try { eventType.call(value); accepted = true; } catch {}
    eventBrands.set(value, accepted);
    return accepted;
  };
  const warn = (path: string, readonly: boolean): void => {
    if (reported.has(path)) return;
    reported.add(path);
    console.warn(source + ": HR007: Destination " + path + (readonly ? " is read-only." : " does not satisfy its declared type."));
  };
  const write = (name: string, keys: readonly string[], value: unknown, readonly: boolean, apply: () => void): boolean => {
    if (readonly || options.acceptsState?.(name, keys, value) === false) warn([name, ...keys].join("."), readonly);
    else apply();
    return true;
  };
  // Each proxy's own object: a value read through host.state and written back is the same value.
  const plain = new WeakMap<object, unknown>();
  const unwrap = (value: unknown): unknown => typeof value === "object" && value !== null && plain.has(value) ? plain.get(value) : value;
  const wrap = (value: unknown, name: string, keys: readonly string[], readonly: boolean): unknown => {
    if (value === null || typeof value !== "object" || nativeEvent(value)) return value;
    const path = [name, ...keys].join(".");
    let paths = nested.get(value);
    if (paths === undefined) nested.set(value, paths = new Map());
    const known = paths.get(path);
    if (known !== undefined) return known;
    // A readonly facade avoids Proxy invariants on frozen source properties.
    const surface = readonly ? (Array.isArray(value) ? [] : Object.create(Object.getPrototypeOf(value))) : value;
    if (readonly && Array.isArray(value)) surface.length = value.length;
    const proxy = new Proxy(surface, {
      get: (_target, key) => wrap(Reflect.get(value, key), name, [...keys, String(key)], readonly),
      set: (_target, key, written) => {
        const next = unwrap(written);
        return write(name, [...keys, String(key)], next, readonly, () => {
          const previous = Reflect.get(value, key);
          if (Reflect.set(value, key, next) && !Object.is(previous, next)) options.changed?.(name);
        });
      },
      has: (_target, key) => Reflect.has(value, key),
      ownKeys: () => Reflect.ownKeys(value),
      getOwnPropertyDescriptor: (_target, key) => {
        if (readonly && Array.isArray(value) && key === "length") { surface.length = value.length; return Reflect.getOwnPropertyDescriptor(surface, key); }
        const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
        return descriptor === undefined ? undefined : readonly ? { ...descriptor, configurable: true } : descriptor;
      },
      deleteProperty: (_target, key) => write(name, [...keys, String(key)], undefined, readonly, () => {
        if (Reflect.has(value, key) && Reflect.deleteProperty(value, key)) options.changed?.(name);
      }),
      defineProperty: (_target, key, descriptor) => {
        if (readonly || !("value" in descriptor) || options.acceptsState?.(name, [...keys, String(key)], descriptor.value) === false) {
          warn([name, ...keys, String(key)].join("."), readonly); return false;
        }
        const changed = Reflect.defineProperty(value, key, descriptor);
        if (changed) options.changed?.(name);
        return changed;
      },
    });
    paths.set(path, proxy);
    plain.set(proxy, value);
    return proxy;
  };
  const state = new Proxy({} as Record<string, unknown>, {
    get: (_target, name) => {
      if (typeof name !== "string") return undefined;
      if (Object.hasOwn(options.state, name)) return wrap(options.state[name]!.get(), name, [], false);
      if (Object.hasOwn(options.computed, name)) return wrap(options.computed[name]!(), name, [], true);
      return undefined;
    },
    set: (_target, name, value) => write(String(name), [], unwrap(value), typeof name !== "string" || !Object.hasOwn(options.state, name),
      () => options.state[String(name)]!.set(unwrap(value))),
    deleteProperty: (_target, name) => { warn(String(name), true); return true; },
    defineProperty: (_target, name) => { warn(String(name), true); return false; },
    has: (_target, name) => typeof name === "string" && (Object.hasOwn(options.state, name) || Object.hasOwn(options.computed, name)),
  });
  const data = new Proxy({} as Record<string, unknown>, {
    get: (_target, name) => typeof name === "string" && Object.hasOwn(options.data ?? {}, name)
      ? wrap(options.data![name]!(), "data." + name, [], true) : undefined,
    set: (_target, name, value) => write("data." + String(name), [], value, true, () => {}),
    deleteProperty: (_target, name) => { warn("data." + String(name), true); return true; },
    defineProperty: (_target, name) => { warn("data." + String(name), true); return false; },
    has: (_target, name) => typeof name === "string" && Object.hasOwn(options.data ?? {}, name),
  });
  return { state, data };
}
`;
