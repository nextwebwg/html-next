/** Browser activation shared by live, native-compiled and framework component hosts. */
export interface ConnectionContext {
  readonly signal: AbortSignal;
}

export type Connect<H> = (host: H, context: ConnectionContext) =>
  void | (() => void) | Promise<void | (() => void)>;

/**
 * Each call owns a fresh native cancellation signal. The facade also owns subscriptions created
 * through host.on/effect after an await: retaining a stale host cannot start a new subscription.
 * It shares the instance's state, props, refs and other capabilities rather than copying them.
 */
export function activateModule<H extends object>(
  module: { readonly connect?: Connect<H> | undefined },
  host: H,
  report: (error: unknown) => void = error => { queueMicrotask(() => { throw error; }); },
): () => void {
  const controller = new AbortController();
  const owned = new Set<() => void>();
  let cleanup: (() => void) | undefined;
  const dispose = (stop: () => void): void => { try { stop(); } catch (error) { report(error); } };
  const scoped = Object.create(host) as H;
  const stop = (): void => {
    if (controller.signal.aborted) return;
    controller.abort();
    for (const release of owned) release();
    const release = cleanup;
    cleanup = undefined;
    if (release !== undefined) dispose(release);
  };
  const failed = (error: unknown): void => {
    const cancelled = controller.signal.aborted && (error as { name?: string } | null)?.name === "AbortError";
    stop();
    if (!cancelled) report(error);
  };
  const own = (stop: () => void): (() => void) => {
    let stopped = false;
    const release = (): void => {
      if (stopped) return;
      stopped = true;
      owned.delete(release);
      dispose(stop);
    };
    if (controller.signal.aborted) release();
    else owned.add(release);
    return release;
  };
  for (const name of ["on", "effect", "computed"] as const) {
    const method: unknown = Reflect.get(host, name);
    if (typeof method !== "function") continue;
    Object.defineProperty(scoped, name, {
      value: (...args: unknown[]) => {
        if (controller.signal.aborted) {
          if (name === "computed") return { get: () => { throw controller.signal.reason; } };
          return () => {};
        }
        const result: unknown = Reflect.apply(method, host, args);
        const stop = name === "computed" ? (result as { stop?: () => void }).stop?.bind(result) : result as () => void;
        if (stop === undefined) return result;
        const release = own(stop);
        return name === "computed" ? result : release;
      },
    });
  }
  // A connection owns its input subscriptions and source capabilities. Disposal releases
  // eligibility for a later activation without disposing the instance's input port or values.
  const inputKey = Symbol.for("@nextwebwg/html-next.inputs.v1");
  const inputs: unknown = Reflect.get(host, inputKey);
  if (inputs !== undefined) {
    const port = Object.create(inputs as object) as { watch(run: () => void | (() => void)): () => void };
    Object.defineProperty(port, "watch", { value: (run: () => void | (() => void)) =>
      controller.signal.aborted ? () => {} : own((inputs as typeof port).watch(run)) });
    const source: unknown = Reflect.get(inputs as object, "source");
    if (typeof source === "function") Object.defineProperty(port, "source", { value: (...args: unknown[]) => {
      if (controller.signal.aborted) throw controller.signal.reason;
      const result = Reflect.apply(source, inputs, args) as { dispose(): void };
      const capability = Object.create(result) as typeof result;
      Object.defineProperty(capability, "dispose", { value: own(() => result.dispose()) });
      return capability;
    } });
    Object.defineProperty(scoped, inputKey, { value: port });
  }
  const accept = (result: void | (() => void)): void => {
    if (result === undefined) return;
    if (typeof result !== "function") { failed(new TypeError("A component connect export must return cleanup or undefined.")); return; }
    if (controller.signal.aborted) dispose(result);
    else cleanup = result;
  };
  try {
    const result = module.connect?.(scoped, { signal: controller.signal });
    if (result !== undefined && typeof result !== "function") void Promise.resolve(result).then(accept, failed);
    else accept(result);
  } catch (error) { failed(error); }
  return stop;
}
