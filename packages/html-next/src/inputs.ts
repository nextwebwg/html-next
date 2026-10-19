/** The public failure a template may read; stacks and producer capabilities stay with their owner. */
export interface InputFailure {
  readonly name: string;
  readonly message: string;
}

/** Availability is independent of the declared value's type, truthiness and input ownership. */
export interface InputStatus {
  readonly ready: boolean;
  readonly pending: boolean;
  readonly error: InputFailure | null;
  readonly stale: boolean;
}

export const READY_INPUT: InputStatus = { ready: true, pending: false, error: null, stale: false };
export const UNRESOLVED_INPUT: InputStatus = { ready: false, pending: false, error: null, stale: false };

/** A draft owns its records/lists; native and opaque objects retain their platform identity. */
export function copyStateSeed<T>(value: T, seen?: WeakMap<object, object>): T {
  if (value === null || typeof value !== "object") return value;
  const array = Array.isArray(value);
  const prototype: unknown = Object.getPrototypeOf(value);
  if (!array && prototype !== null && prototype !== Object.prototype) return value;
  const known = seen ?? new WeakMap<object, object>();
  const previous = known.get(value);
  if (previous !== undefined) return previous as T;
  const copy = array ? [] : Object.create(prototype as object | null) as object;
  if (array) (copy as unknown[]).length = value.length;
  known.set(value, copy);
  for (const key of Reflect.ownKeys(value)) if (Object.getOwnPropertyDescriptor(value, key)?.enumerable) {
    Object.defineProperty(copy, key, { enumerable: true, writable: true, configurable: true,
      value: copyStateSeed(Reflect.get(value, key), known) });
  }
  return copy as T;
}

/** Public error identity is its name/message, not the producer's object allocation. */
export function sameInputStatus(left: InputStatus | undefined, right: InputStatus | undefined): boolean {
  return left === right || left !== undefined && right !== undefined && left.ready === right.ready &&
    left.pending === right.pending && left.stale === right.stale && left.error?.name === right.error?.name &&
    left.error?.message === right.error?.message;
}

interface InputObservation { ready: boolean; pending: boolean; error: InputFailure | null; stale: boolean }
let inputObservation: InputObservation | undefined;

/** Only synchronous reads made by this evaluation contribute prerequisites. */
export function observingInputs(): boolean { return inputObservation !== undefined; }

/** Validation can examine reference paths without declaring them evaluated prerequisites. */
export function withoutInputObservation<T>(run: () => T): T {
  const previous = inputObservation;
  inputObservation = undefined;
  try { return run(); } finally { inputObservation = previous; }
}

export function observeInputStatus(status: InputStatus): void {
  if (inputObservation === undefined) return;
  inputObservation.ready &&= status.ready;
  inputObservation.pending ||= status.pending;
  inputObservation.error ??= status.error;
  inputObservation.stale ||= status.stale;
}

/** Compiler adapters wrap declaration reads; ordinary application values keep their types. */
export function inputRead<T>(value: T, status: InputStatus): T {
  observeInputStatus(status);
  return value;
}

/** Native expression evaluation and framework computeds share status composition, not reactivity. */
export function evaluateInput<T>(compute: () => T, previous?: InputStatus, invalid: unknown = Symbol.for("html-next.invalid-result")): { readonly value: T; readonly status: InputStatus } {
  const parent = inputObservation;
  const observed: InputObservation = { ready: true, pending: false, error: null, stale: false };
  inputObservation = observed;
  let value: T;
  try { value = compute(); }
  finally { inputObservation = parent; }
  if (value === undefined || value === invalid && previous?.ready !== true) observed.ready = false;
  if (!observed.ready) observed.stale = false;
  const same = sameInputStatus(previous, observed);
  const status = same ? previous! : observed.ready && !observed.pending && observed.error === null && !observed.stale
    ? READY_INPUT : !observed.ready && !observed.pending && observed.error === null ? UNRESOLVED_INPUT : observed;
  return { value, status };
}

/** The adapter supplies its own memo/computed primitive; acceptance runs only for available data. */
export function inputComputed<T>(compute: () => T,
  make: <V>(read: () => V) => { get(): V }, accept?: (value: T) => T,
): { get(): T | null; readonly value: T | null; status(): InputStatus } {
  let previous: { readonly value: T | null; readonly status: InputStatus } | undefined;
  const cell = make(() => {
    const result = evaluateInput(compute, previous?.status);
    const value = result.status.ready ? accept === undefined ? result.value : accept(result.value) : null;
    if (previous !== undefined && Object.is(previous.value, value) && previous.status === result.status) return previous;
    return previous = { value, status: result.status };
  });
  return { get: () => cell.get().value, get value() { return cell.get().value; }, status: () => cell.get().status };
}

/** Project only the status a template may observe, retaining no mutable producer-owned object. */
export function publicInputStatus(status: InputStatus): InputStatus {
  if (typeof status.ready !== "boolean" || typeof status.pending !== "boolean" || typeof status.stale !== "boolean" || !status.ready && status.stale) {
    throw new TypeError("Input status requires boolean ready, pending and stale; stale requires an accepted value.");
  }
  const error = status.error;
  if (error !== null && (typeof error.name !== "string" || typeof error.message !== "string")) {
    throw new TypeError("An input failure requires public string name and message fields.");
  }
  return { ready: status.ready, pending: status.pending, stale: status.stale,
    error: error === null ? null : { name: error.name, message: error.message } };
}

/** An await group consumes a status, never a Promise or an instruction to start a producer. */
export function readInputStatus(
  scope: { get(name: string): unknown; inputStatus?(name: string): InputStatus },
  name: string,
  handlesError: boolean,
): InputStatus {
  const status = scope.inputStatus?.(name) ?? (scope.get(name) === undefined ? UNRESOLVED_INPUT : READY_INPUT);
  return requireInputStatus(status, handlesError);
}

export function requireInputStatus(status: InputStatus, handlesError: boolean): InputStatus {
  if (!status.ready && status.error !== null && !handlesError) {
    throw Object.assign(new Error(status.error.message), { name: status.error.name });
  }
  return status;
}

/** A source proposes a value and availability; the renderer retains typed-value acceptance. */
export interface InputSnapshot<T = unknown> {
  readonly value?: T;
  readonly status: InputStatus;
}

/** A synchronous read and the availability of the declarations it actually evaluated. */
export type InputEvaluation<T> = { readonly status: InputStatus } & (
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown }
);

export interface InputSource<T = unknown> {
  /** The accepted component value, which can differ from a refused source result. */
  current(): InputSnapshot<T>;
  /** False when a caller owns this input, the source ended, or normal type acceptance refused it. */
  publish(snapshot: InputSnapshot<T>): boolean;
  /** Ends this source's write capability; deactivation alone need not release a retained source. */
  dispose(): void;
}

export interface ComponentInputs {
  readonly names: readonly string[];
  /** Props plus declared state, computed values and context aliases; only props accept sources. */
  readonly readNames: readonly string[];
  read(name: string): unknown;
  status(name: string): InputStatus;
  supplied(name: string): boolean;
  /** Opaque, nonreactive revision for validating retained producer data; undefined means uncacheable. */
  revision(name: string): number | undefined;
  /** Runs in the renderer's observation scope, including when a driver is bundled separately. */
  capture<T>(read: () => T): InputEvaluation<T>;
  source<T = unknown>(name: string): InputSource<T>;
  /** A source owner stops this subscription when its preparation or activation ends. */
  watch(run: () => void | (() => void)): () => void;
}

export interface InputPortAdapter {
  readonly names: readonly string[];
  readonly readNames?: readonly string[];
  read(name: string): unknown;
  status(name: string): InputStatus;
  supplied(name: string): boolean;
  /** Enable/read accepted-input commit tracking only when a driver asks for it. */
  revision?(name: string): number;
  /** Validate against the whole accepted candidate, then commit value and status together. */
  publish(name: string, snapshot: InputSnapshot): boolean;
  /** Publishing is write bookkeeping; it must not subscribe a producer to its own output. */
  untracked<T>(run: () => T): T;
  watch(run: () => void | (() => void)): () => void;
}

/** Shared SDK protocol; no source configuration or server/browser execution policy lives here. */
export const INPUT_PORT = Symbol.for("@nextwebwg/html-next.inputs.v1");

export function componentInputs(host: object): ComponentInputs {
  const port: unknown = Reflect.get(host, INPUT_PORT);
  if (port === undefined) throw new TypeError("This host does not expose component inputs.");
  return port as ComponentInputs;
}

/**
 * One source capability per prop. The adapter owns accepted storage and type checks; this port
 * owns neither a second value store nor a second reactive engine. It also enforces caller precedence
 * before the adapter sees any source proposal, including proposals that arrive after disposal.
 */
export function createInputPort(adapter: InputPortAdapter): ComponentInputs {
  const names = [...adapter.names];
  const readNames = [...new Set([...names, ...adapter.readNames ?? []])];
  const owners = new Map<string, object>();
  const declared = (name: string): void => {
    if (!names.includes(name)) throw new TypeError(`Input \`${name}\` is not a declared prop.`);
  };
  const readable = (name: string): void => {
    if (!readNames.includes(name)) throw new TypeError(`Binding \`${name}\` is not declared in this component.`);
  };
  return {
    get names() { return [...names]; },
    get readNames() { return [...readNames]; },
    read(name: string) {
      readable(name);
      const value = adapter.read(name);
      if (observingInputs()) observeInputStatus(adapter.status(name));
      return value;
    },
    status(name: string) { readable(name); return publicInputStatus(adapter.status(name)); },
    supplied(name: string) { declared(name); return adapter.supplied(name); },
    revision(name: string) { declared(name); return adapter.revision?.(name); },
    capture<T>(read: () => T): InputEvaluation<T> {
      const result = evaluateInput(() => {
        try { return { ok: true as const, value: read() }; }
        catch (error) { return { ok: false as const, error }; }
      });
      return { ...result.value, status: publicInputStatus(result.status) };
    },
    watch: (run: () => void | (() => void)) => adapter.watch(run),
    source<T>(name: string): InputSource<T> {
      declared(name);
      if (owners.has(name)) throw new TypeError(`Input \`${name}\` already has a source.`);
      const token = {};
      owners.set(name, token);
      return {
        current: () => ({ value: adapter.read(name) as T, status: publicInputStatus(adapter.status(name)) }),
        publish(snapshot: InputSnapshot<T>): boolean {
          if (owners.get(name) !== token) return false;
          return adapter.untracked(() => !adapter.supplied(name) &&
            adapter.publish(name, { value: snapshot.value, status: publicInputStatus(snapshot.status) }));
        },
        dispose() { if (owners.get(name) === token) owners.delete(name); },
      };
    },
  };
}
