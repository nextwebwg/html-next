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
  const nativeEvent = (value: object): boolean => {
    if (!("type" in value) || eventType === undefined) return false;
    try { eventType.call(value); return true; } catch { return false; }
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
  const wrap = (value: unknown, name: string, keys: readonly string[], readonly: boolean): unknown => {
    if (value === null || typeof value !== "object" || nativeEvent(value)) return value;
    const path = [name, ...keys].join(".");
    let paths = nested.get(value);
    if (paths === undefined) nested.set(value, paths = new Map());
    const known = paths.get(path);
    if (known !== undefined) return known;
    const proxy = new Proxy(value, {
      get: (target, key, receiver) => wrap(Reflect.get(target, key, receiver), name, [...keys, String(key)], readonly),
      set: (target, key, next) => write(name, [...keys, String(key)], next, readonly, () => {
        const previous = Reflect.get(target, key);
        Reflect.set(target, key, next);
        if (!Object.is(previous, next)) options.changed?.(name);
      }),
    });
    paths.set(path, proxy);
    return proxy;
  };
  const state = new Proxy({} as Record<string, unknown>, {
    get: (_target, name) => {
      if (typeof name !== "string") return undefined;
      if (Object.hasOwn(options.state, name)) return wrap(options.state[name]!.get(), name, [], false);
      if (Object.hasOwn(options.computed, name)) return wrap(options.computed[name]!(), name, [], true);
      return undefined;
    },
    set: (_target, name, value) => write(String(name), [], value, typeof name !== "string" || !Object.hasOwn(options.state, name),
      () => options.state[String(name)]!.set(value)),
    has: (_target, name) => typeof name === "string" && (Object.hasOwn(options.state, name) || Object.hasOwn(options.computed, name)),
  });
  const data = new Proxy({} as Record<string, unknown>, {
    get: (_target, name) => typeof name === "string" && Object.hasOwn(options.data ?? {}, name)
      ? wrap(options.data![name]!(), "data." + name, [], true) : undefined,
    set: (_target, name, value) => write("data." + String(name), [], value, true, () => {}),
    has: (_target, name) => typeof name === "string" && Object.hasOwn(options.data ?? {}, name),
  });
  return { state, data };
}
`;
