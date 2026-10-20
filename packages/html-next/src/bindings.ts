/** Selected-input reads over the renderer's existing typed input and reactive boundaries. */
import { parseDuration } from "./duration.js";
import { decodeHydrationValue, encodeHydrationValue } from "./hydration-value.js";
import { componentInputs, READY_INPUT, sameInputStatus, type ComponentInputs, type InputFailure, type InputSource, type InputStatus } from "./inputs.js";

export type BindingPhase = "build" | "request" | "browser";
export type BindingDuration = number | string;
export interface BindingOperation {
  readonly phase: BindingPhase;
  readonly signal: AbortSignal;
  readonly fetch: typeof fetch;
  readonly sample: unknown;
  readonly services: unknown;
}
export interface BindingSubscription extends BindingOperation {
  /** False after cancellation, replacement, a caller override, or type refusal. */
  publish(value: unknown): boolean;
}
export interface BindingSelectionContext<S = Readonly<Record<string, unknown>>> extends Readonly<Record<string, unknown>> {
  /** Declared state, computed values and context aliases in the component's existing namespace. */
  readonly state: S;
}
export interface BindingProvider<P = Readonly<Record<string, unknown>>, I = unknown, V = unknown, S = Readonly<Record<string, unknown>>> {
  readonly input: (props: P, context: BindingSelectionContext<S>) => I;
  readonly load?: (input: I, operation: BindingOperation) => V | PromiseLike<V>;
  readonly when?: (props: P, context: BindingSelectionContext<S>) => unknown;
  readonly sample?: (props: P, context: BindingSelectionContext<S>) => unknown;
  readonly initial?: "render" | "browser" | "manual";
  readonly debounce?: BindingDuration;
  readonly timeout?: BindingDuration;
  readonly poll?: BindingDuration;
  readonly keepPrevious?: boolean;
  readonly revalidate?: "activate";
  readonly subscribe?: ((input: I, operation: BindingSubscription) => void | (() => void) | PromiseLike<void | (() => void)>) | {
    readonly input: (props: P, context: BindingSelectionContext<S>) => unknown;
    readonly open: (input: unknown, operation: BindingSubscription) => void | (() => void) | PromiseLike<void | (() => void)>;
  };
}
// Each configuration retains its own inferred selected/output types; runtime checking belongs to the port.
export type BindingProviders = Readonly<Record<string, BindingProvider<any, any, any, any> | false>>;
export interface BindingReadSnapshot {
  /** The last attempted input and, separately, the input of any retained accepted value. */
  readonly input: string;
  readonly value?: string;
  readonly error?: InputFailure;
  readonly revision: number;
}
/** Read identities only; accepted values and ownership travel in the renderer's record. */
export interface BindingSnapshot {
  readonly source: string;
  readonly reads: Readonly<Record<string, BindingReadSnapshot>>;
}
export interface BindingScopeOptions {
  readonly phase: BindingPhase;
  readonly context?: Readonly<Record<string, unknown>>;
  readonly services?: unknown;
  readonly fetch?: typeof fetch;
  readonly signal?: AbortSignal;
  readonly report?: (error: unknown) => void;
  /** Build/module revision supplied by the application host for matching preparation and adoption. */
  readonly source?: string;
  readonly snapshot?: BindingSnapshot;
}
interface Selected { readonly value: unknown; readonly key: string }
interface Selection {
  readonly enabled: boolean;
  readonly status: InputStatus;
  readonly input?: Selected;
  readonly stream?: { readonly status: InputStatus; readonly input?: Selected; readonly failure?: InputFailure };
  readonly failure?: InputFailure;
}
interface Operation { readonly abort: AbortController; readonly key: string; done: Promise<void> }
interface Stream { readonly abort: AbortController; readonly key: string; waiting: boolean; cleanup?: () => void }
interface RecordState {
  readonly name: string;
  readonly provider: BindingProvider<any, any, any, any>;
  readonly debounce: number;
  readonly timeout: number | undefined;
  readonly poll: number;
  readonly dependencies: Set<string>;
  source?: InputSource | undefined;
  stopWatch?: (() => void) | undefined;
  selection?: Selection | undefined;
  eligible: boolean;
  /** A requested selected key, or true for revalidation when activation obtains an input. */
  requested?: string | true | undefined;
  loaded?: string | undefined;
  attempted?: string | undefined;
  error?: InputFailure | undefined;
  revision?: number | undefined;
  operation?: Operation | undefined;
  stream?: Stream | undefined;
  pollTimer?: ReturnType<typeof setTimeout> | undefined;
  cycle?: string | undefined;
  seed?: BindingReadSnapshot | undefined;
}

function duration(value: BindingDuration | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = typeof value === "number" ? value : parseDuration(value);
  if (parsed === undefined || !Number.isFinite(parsed) || parsed < 0) throw new TypeError(`Binding ${name} must be a nonnegative time.`);
  return parsed;
}
class SelectionContractError extends TypeError {}
class UnavailableInput extends Error {
  constructor(name: string) { super(`Binding input ${name} is not available.`); this.name = "InputUnavailableError"; }
}
function synchronous(value: unknown, label = "A binding selector"): unknown {
  if (value !== null && (typeof value === "object" || typeof value === "function") && typeof (value as { then?: unknown }).then === "function") {
    void Promise.resolve(value).catch(() => {});
    throw new SelectionContractError(`${label} must return synchronously; put asynchronous work in load.`);
  }
  return value;
}
function selected(value: unknown): Selected {
  synchronous(value);
  // The existing transfer codec validates plain data and preserves undefined, -0 and shared references.
  const key = JSON.stringify(encodeHydrationValue(value));
  return { key, value: decodeHydrationValue(JSON.parse(key)) };
}
function failure(error: unknown): InputFailure {
  return { name: error instanceof Error ? error.name : "Error", message: error instanceof Error ? error.message : String(error) };
}
function abortable<T>(value: T | PromiseLike<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const aborted = (): void => { reject(signal.reason); };
    signal.addEventListener("abort", aborted, { once: true });
    Promise.resolve(value).then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
  });
}
function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const aborted = (): void => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", aborted); resolve(); }, milliseconds);
    signal.addEventListener("abort", aborted, { once: true });
  });
}

/** A logical instance's read ownership; accepted output values stay exclusively in its renderer. */
export class BindingScope {
  readonly #records = new Map<string, RecordState>();
  readonly #options: BindingScopeOptions;
  readonly #props: Readonly<Record<string, unknown>>;
  readonly #context: BindingSelectionContext;
  readonly #fetch: typeof fetch;
  #port: ComponentInputs;
  #active = false;
  #disposed = false;
  #queued = false;
  #reading: RecordState | undefined;
  #sampling = false;
  #removeAbort: (() => void) | undefined;
  #reason: unknown;
  #activation: object | undefined;

  constructor(port: ComponentInputs, providers: BindingProviders, options: BindingScopeOptions) {
    this.#port = port;
    this.#options = options;
    if (options.source !== undefined && (typeof options.source !== "string" || options.source.trim() === "")) throw new TypeError("A binding source revision must be a nonempty string.");
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    const props = Object.create(null) as Record<string, unknown>;
    for (const name of port.names) Object.defineProperty(props, name, { enumerable: true, get: () => {
      if (this.#reading === undefined && !this.#sampling) throw new TypeError(`Read ${name} in input, when or sample; load receives its captured input.`);
      this.#reading?.dependencies.add(name);
      const value = this.#port.read(name);
      if (!this.#port.status(name).ready) throw new UnavailableInput(name);
      return value;
    } });
    this.#props = props;
    const state = Object.create(null) as Record<string, unknown>;
    for (const name of port.readNames) if (!port.names.includes(name)) Object.defineProperty(state, name, { enumerable: true, get: () => {
      if (this.#reading === undefined && !this.#sampling) throw new TypeError(`Read ${name} in input, when or sample; load receives its captured input.`);
      this.#reading?.dependencies.add(name);
      const value = this.#port.read(name);
      if (!this.#port.status(name).ready) throw new UnavailableInput(name);
      return value;
    } });
    const context = Object.create(null) as BindingSelectionContext;
    for (const name of Object.keys(options.context ?? {})) if (name !== "state") Object.defineProperty(context, name, {
      enumerable: true, get: () => options.context![name],
    });
    Object.defineProperty(context, "state", { enumerable: true, value: state });
    this.#context = context;
    for (const [name, provider] of Object.entries(providers)) {
      if (!port.names.includes(name)) throw new TypeError(`Binding output ${name} is not a declared prop.`);
      if (provider === false) continue;
      if (provider === null || typeof provider !== "object" || typeof provider.input !== "function" || provider.load === undefined && provider.subscribe === undefined) {
        throw new TypeError(`Binding ${name} requires a synchronous input selector and load or subscribe.`);
      }
      for (const field of ["load", "when", "sample"] as const) if (provider[field] !== undefined && typeof provider[field] !== "function") {
        throw new TypeError(`Binding ${name}.${field} must be a function.`);
      }
      if (provider.initial !== undefined && !["render", "browser", "manual"].includes(provider.initial)) throw new TypeError(`Binding ${name}.initial must be render, browser or manual.`);
      if (provider.revalidate !== undefined && provider.revalidate !== "activate") throw new TypeError(`Binding ${name}.revalidate must be activate.`);
      if (provider.keepPrevious !== undefined && typeof provider.keepPrevious !== "boolean") throw new TypeError(`Binding ${name}.keepPrevious must be boolean.`);
      const subscription = provider.subscribe;
      if (subscription !== undefined && typeof subscription !== "function" &&
        (subscription === null || typeof subscription !== "object" || typeof subscription.input !== "function" || typeof subscription.open !== "function")) {
        throw new TypeError(`Binding ${name}.subscribe requires a function or { input, open } functions.`);
      }
      const poll = duration(provider.poll, "poll") ?? 0;
      if (provider.initial === "manual" && poll > 0) throw new TypeError(`Manual binding ${name} cannot also poll.`);
      const timeout = duration(provider.timeout, "timeout");
      const snapshot = options.snapshot;
      const seed = options.source !== undefined && snapshot?.source === options.source &&
        Object.hasOwn(snapshot.reads ?? {}, name) ? snapshot.reads[name] : undefined;
      if (seed !== undefined && (seed === null || typeof seed !== "object" || typeof seed.input !== "string" ||
        seed.value !== undefined && typeof seed.value !== "string" || !Number.isSafeInteger(seed.revision) || seed.revision < 0 ||
        seed.error !== undefined && (seed.error === null || typeof seed.error !== "object" || typeof seed.error.name !== "string" || typeof seed.error.message !== "string"))) {
        throw new TypeError(`Malformed prepared binding ${name}.`);
      }
      this.#records.set(name, { name, provider, eligible: false, dependencies: new Set(),
        seed: seed === undefined ? undefined : { ...seed, ...(seed.error === undefined ? {} : { error: { ...seed.error } }) },
        debounce: duration(provider.debounce, "debounce") ?? 0, timeout: timeout === 0 ? undefined : timeout, poll });
    }
  }

  /** Configured outputs, including deferred reads and excluding disabled providers. */
  get names(): readonly string[] { return [...this.#records.keys()]; }

  activate(port = this.#port, signal = this.#options.signal): void {
    if (this.#disposed) throw new TypeError("This binding scope has been disposed.");
    if (this.#active) return;
    if (signal?.aborted) throw signal.reason;
    this.#port = port;
    this.#active = true;
    this.#activation = {};
    this.#reason = undefined;
    try {
      for (const record of this.#records.values()) {
        record.source = port.source(record.name);
        const revision = port.revision(record.name);
        if ((record.loaded !== undefined || record.attempted !== undefined) && (revision === undefined || revision !== record.revision)) {
          record.loaded = undefined; record.attempted = undefined; record.error = undefined;
        }
        record.revision = revision;
        const seed = record.seed; record.seed = undefined;
        if (seed !== undefined && seed.revision === revision) {
          record.loaded = record.source.current().status.ready ? seed.value : undefined;
          record.attempted = seed.input;
          record.error = seed.error;
        }
      }
      if (signal !== undefined) {
        const abort = (): void => { this.deactivate(signal.reason); };
        signal.addEventListener("abort", abort, { once: true });
        this.#removeAbort = () => signal.removeEventListener("abort", abort);
      }
      for (const record of this.#records.values()) {
        if (this.#options.phase === "browser" && record.provider.revalidate === "activate" &&
          (record.provider.initial !== "manual" || record.attempted !== undefined || record.seed !== undefined)) record.requested = true;
        record.stopWatch = port.watch(() => this.#select(record));
      }
      this.#queue();
    } catch (error) { this.deactivate(error); throw error; }
  }

  deactivate(reason: unknown = new DOMException("Binding scope deactivated.", "AbortError")): void {
    if (!this.#active) return;
    this.#active = false;
    this.#activation = undefined;
    this.#reason = reason;
    this.#removeAbort?.(); this.#removeAbort = undefined;
    for (const record of this.#records.values()) {
      record.stopWatch?.(); record.stopWatch = undefined;
      if (record.operation !== undefined) record.requested ??= record.operation.key;
      this.#cancel(record);
      const current = record.source?.current();
      if (current?.status.pending) this.#commit(record, current.value, { ...current.status, pending: false });
      record.source?.dispose(); record.source = undefined;
    }
  }

  dispose(): void { this.deactivate(); this.#disposed = true; }

  snapshot(): BindingSnapshot {
    if (this.#options.source === undefined) throw new TypeError("A source revision is required to transfer binding completion identities.");
    const reads: Record<string, BindingReadSnapshot> = Object.create(null) as Record<string, BindingReadSnapshot>;
    for (const record of this.#records.values()) {
      const input = record.attempted ?? record.loaded;
      if (input !== undefined && record.operation === undefined && !this.#port.supplied(record.name) &&
        record.revision !== undefined && record.revision === this.#port.revision(record.name)) reads[record.name] = {
          input, revision: record.revision,
          ...(record.loaded === undefined || !this.#port.status(record.name).ready ? {} : { value: record.loaded }),
          ...(record.error === undefined ? {} : { error: { ...record.error } }),
        };
    }
    return { source: this.#options.source, reads };
  }

  /** Revalidates a read; supplied values and explicitly disabled providers stay in control. */
  async refresh(name: string): Promise<void> {
    if (this.#disposed) throw new TypeError("This binding scope has been disposed.");
    if (!this.#port.names.includes(name)) throw new TypeError(`Binding ${name} is not a declared prop.`);
    const record = this.#records.get(name);
    if (record === undefined || this.#port.supplied(name)) return;
    const activation = this.#activation;
    // Commands sample accepted inputs outside the caller's reactive execution.
    await Promise.resolve();
    if (this.#disposed || activation !== undefined && activation !== this.#activation) return;
    this.#select(record);
    if (!record.eligible || !record.selection?.enabled || !record.selection.status.ready || record.selection.input === undefined) return;
    record.requested = record.selection.input.key;
    if (!this.#active) return;
    this.#queue();
    try { await this.settled(); }
    catch (error) { if (this.#active || this.#reason === undefined) throw error; }
  }

  /** Waits for current owned reads, including preparation dependencies, rather than obsolete work. */
  async settled(): Promise<void> {
    for (;;) {
      await Promise.resolve();
      if (!this.#active) { if (this.#reason !== undefined) throw this.#reason; return; }
      const jobs = [...this.#records.values()].flatMap(record => record.operation === undefined ? [] : [record.operation.done]);
      if (jobs.length > 0) await Promise.all(jobs);
      else if (!this.#queued) { await Promise.resolve(); if (!this.#queued) return; }
    }
  }

  #capture(read: () => unknown): { readonly input?: Selected; readonly status: InputStatus; readonly failure?: InputFailure } {
    const result = this.#port.capture(() => selected(read()));
    if (result.ok) return { input: result.value, status: result.status };
    return !result.status.ready && !(result.error instanceof SelectionContractError) ? { status: result.status }
      : { status: READY_INPUT, failure: failure(result.error) };
  }

  #select(record: RecordState): void {
    record.dependencies.clear();
    record.eligible = !this.#port.supplied(record.name);
    if (!record.eligible) { record.selection = undefined; this.#queue(); return; }
    this.#reading = record;
    try {
      const context = this.#context;
      const when = this.#capture(() => record.provider.when === undefined ? true : !!synchronous(record.provider.when(this.#props, context)));
      if (when.failure !== undefined || !when.status.ready || !when.input?.value) {
        record.selection = { enabled: false, status: when.status, ...(when.failure === undefined ? {} : { failure: when.failure }) };
      } else {
        const input = this.#capture(() => record.provider.input(this.#props, context));
        const subscribe = record.provider.subscribe;
        const stream = typeof subscribe === "object" ? this.#capture(() => subscribe.input(this.#props, context)) : input;
        const status: InputStatus = { ready: input.status.ready, pending: when.status.pending || input.status.pending,
          stale: input.status.ready && (when.status.stale || input.status.stale), error: when.status.error ?? input.status.error };
        record.selection = { enabled: true, status, ...(input.input === undefined ? {} : { input: input.input }),
          ...(input.failure === undefined ? {} : { failure: input.failure }), ...(subscribe === undefined ? {} : { stream }) };
      }
    } finally { this.#reading = undefined; }
    this.#queue();
  }

  #queue(): void {
    if (!this.#active || this.#queued) return;
    this.#queued = true;
    queueMicrotask(() => {
      this.#queued = false;
      if (!this.#active) return;
      const cycles = this.#cycles();
      for (const record of this.#records.values()) {
        const message = cycles.get(record.name);
        if (message !== undefined) {
          if (record.cycle !== message) { this.#cancel(record); this.#fail(record, { name: "BindingCycleError", message }); }
          record.cycle = message;
        } else { record.cycle = undefined; this.#plan(record); }
      }
    });
  }

  #cycles(): ReadonlyMap<string, string> {
    const cycles = new Map<string, string>();
    const visited = new Set<string>();
    const path: string[] = [];
    const visit = (name: string): void => {
      const at = path.indexOf(name);
      if (at >= 0) {
        const cycle = [...path.slice(at), name];
        const message = `Binding cycle: ${cycle.join(" -> ")}.`;
        for (const member of cycle) cycles.set(member, message);
        return;
      }
      const record = this.#records.get(name);
      if (record === undefined || !record.eligible || record.selection === undefined ||
        !record.selection.enabled && record.selection.status.ready || visited.has(name)) return;
      visited.add(name); path.push(name);
      for (const dependency of record.dependencies) visit(dependency);
      path.pop();
    };
    for (const name of this.#records.keys()) visit(name);
    return cycles;
  }

  #plan(record: RecordState): void {
    const selection = record.selection;
    if (!record.eligible || selection === undefined) { this.#cancel(record); record.loaded = undefined; record.attempted = undefined; record.error = undefined; record.requested = undefined; return; }
    if (selection.failure !== undefined) { this.#cancel(record); record.attempted = undefined; this.#fail(record, selection.failure); return; }
    if (selection.enabled && selection.status.ready && selection.status.stale) {
      this.#cancel(record);
      if (record.attempted !== selection.input?.key) record.error = undefined;
      const retain = record.loaded !== undefined && (record.loaded === selection.input?.key || !!record.provider.keepPrevious);
      if (!retain) record.loaded = undefined;
      this.#publish(record, retain, selection.status.pending, record.error ?? selection.status.error, retain);
      return;
    }
    if (!selection.enabled || !selection.status.ready || selection.input === undefined) {
      this.#cancel(record);
      record.attempted = undefined;
      record.error = undefined;
      if (selection.status.ready) record.requested = undefined;
      if (!selection.status.ready) {
        const retain = record.provider.keepPrevious && record.loaded !== undefined;
        if (!retain) record.loaded = undefined;
        this.#publish(record, !!retain, selection.status.pending, selection.status.error, !!retain);
      } else this.#publish(record, record.loaded !== undefined, false, null, false);
      return;
    }
    if (record.requested !== true && record.requested !== selection.input.key) record.requested = undefined;
    if (record.operation !== undefined) {
      if (record.operation.key === selection.input.key && record.requested === undefined) return;
      this.#cancel(record);
    }
    const automatic = record.provider.initial !== "manual" && (record.provider.initial !== "browser" || this.#options.phase === "browser");
    if (record.attempted !== selection.input.key) record.error = undefined;
    if (record.loaded !== selection.input.key && !record.provider.keepPrevious) record.loaded = undefined;
    if (record.provider.load !== undefined && (record.requested !== undefined || automatic && record.attempted !== selection.input.key)) {
      this.#start(record, selection.input);
    } else {
      if (record.requested !== undefined) {
        this.#stopStream(record);
        if (record.provider.load === undefined) record.attempted = selection.input.key;
      }
      record.requested = undefined;
      const status = this.#valueStatus(selection);
      this.#publish(record, record.loaded !== undefined, status.pending || !!record.stream?.waiting, record.error ?? status.error,
        record.loaded !== undefined && (record.loaded !== selection.input.key || selection.status.stale));
      this.#subscribe(record);
      this.#poll(record);
    }
  }

  #valueStatus(selection: Selection): InputStatus {
    return { ready: true, pending: selection.status.pending || !!selection.stream?.status.pending,
      error: selection.status.error ?? selection.stream?.failure ?? selection.stream?.status.error ?? null, stale: selection.status.stale };
  }

  #currentSelection(record: RecordState, key: string): Selection | undefined {
    this.#select(record);
    const selection = record.selection;
    return record.eligible && selection?.enabled && selection.status.ready && !selection.status.stale &&
      selection.failure === undefined && selection.input?.key === key ? selection : undefined;
  }

  #publish(record: RecordState, ready: boolean, pending: boolean, error: InputFailure | null, stale: boolean): boolean {
    const current = record.source?.current();
    const status = { ready, pending, error, stale: ready && stale };
    if (this.#port.supplied(record.name)) return false;
    if (current !== undefined && sameInputStatus(current.status, status)) return true;
    return this.#commit(record, ready ? current?.value : undefined, status);
  }

  #commit(record: RecordState, value: unknown, status: InputStatus): boolean {
    const accepted = record.source?.publish({ value, status }) ?? false;
    if (accepted) record.revision = this.#port.revision(record.name);
    return accepted;
  }

  #cancel(record: RecordState): void {
    const operation = record.operation; record.operation = undefined;
    if (operation !== undefined) record.attempted = undefined;
    operation?.abort.abort();
    if (record.pollTimer !== undefined) clearTimeout(record.pollTimer);
    record.pollTimer = undefined;
    this.#stopStream(record);
  }

  #fail(record: RecordState, error: InputFailure): void {
    record.error = error;
    const key = record.selection?.input?.key;
    const retain = record.loaded !== undefined && (record.loaded === key || !!record.provider.keepPrevious);
    if (!retain) record.loaded = undefined;
    this.#publish(record, retain, false, error, retain && record.loaded !== key);
  }

  #operation(signal: AbortSignal, sample: unknown): BindingOperation {
    return { phase: this.#options.phase, signal, fetch: this.#fetch, sample, services: this.#options.services };
  }

  #sample(record: RecordState): unknown {
    this.#sampling = true;
    try { return selected(record.provider.sample?.(this.#props, this.#context)).value; }
    finally { this.#sampling = false; }
  }

  #start(record: RecordState, input: Selected): void {
    this.#cancel(record);
    const explicit = record.requested !== undefined;
    record.requested = undefined;
    const operation: Operation = { abort: new AbortController(), key: input.key, done: Promise.resolve() };
    record.operation = operation;
    record.attempted = input.key;
    record.error = undefined;
    const retain = record.loaded !== undefined && (record.loaded === input.key || !!record.provider.keepPrevious);
    if (!retain) record.loaded = undefined;
    this.#publish(record, retain, true, null, retain && record.loaded !== input.key);
    operation.done = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        if (!explicit && this.#options.phase === "browser" && record.debounce > 0) await delay(record.debounce, operation.abort.signal);
        if (record.operation !== operation || !this.#active || this.#port.supplied(record.name) || this.#currentSelection(record, input.key) === undefined) return;
        const sample = this.#sample(record);
        if (record.timeout !== undefined) timer = setTimeout(() => operation.abort.abort(new DOMException(`Binding ${record.name} timed out.`, "TimeoutError")), record.timeout);
        const value = await abortable(record.provider.load!(structuredClone(input.value), this.#operation(operation.abort.signal, sample)), operation.abort.signal);
        if (record.operation !== operation || !this.#active || this.#port.supplied(record.name)) return;
        const current = this.#currentSelection(record, input.key);
        if (current === undefined) return;
        if (!this.#commit(record, value, this.#valueStatus(current))) throw new TypeError(`Binding ${record.name} produced a value outside its declared type.`);
        record.loaded = input.key;
        record.error = undefined;
      } catch (error) {
        if (record.operation === operation && this.#active && !this.#port.supplied(record.name) && this.#currentSelection(record, input.key) !== undefined) this.#fail(record, failure(error));
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        if (record.operation === operation) {
          record.operation = undefined;
          this.#subscribe(record);
          this.#poll(record);
        }
      }
    })();
  }

  #poll(record: RecordState): void {
    if (!this.#active || this.#options.phase !== "browser" || record.poll === 0 || record.pollTimer !== undefined ||
      record.provider.load === undefined || !record.eligible || !record.selection?.enabled || !record.selection.status.ready || record.selection.status.stale ||
      record.selection.input === undefined || record.attempted !== record.selection.input.key) return;
    record.pollTimer = setTimeout(() => {
      record.pollTimer = undefined; record.requested = record.selection?.input?.key; this.#queue();
    }, record.poll);
  }

  #stopStream(record: RecordState): void {
    const stream = record.stream; record.stream = undefined;
    stream?.abort.abort();
    if (stream?.cleanup !== undefined) this.#cleanup(stream.cleanup);
  }

  #cleanup(cleanup: () => void): void {
    try { cleanup(); } catch (error) { queueMicrotask(() => {
      if (this.#options.report !== undefined) this.#options.report(error); else throw error;
    }); }
  }

  #subscribe(record: RecordState): void {
    const config = record.provider.subscribe;
    const selection = record.selection;
    const input = selection?.stream?.input;
    if (!this.#active || this.#options.phase !== "browser" || !record.eligible || record.operation !== undefined || config === undefined ||
      !selection?.enabled || !selection.stream?.status.ready || selection.stream.status.stale || selection.stream.failure !== undefined || input === undefined || record.provider.load !== undefined && record.loaded === undefined) {
      this.#stopStream(record); return;
    }
    if (record.provider.initial === "manual" && record.attempted !== selection.input?.key) { this.#stopStream(record); return; }
    if (record.stream?.key === input.key) return;
    this.#stopStream(record);
    const stream: Stream = { key: input.key, abort: new AbortController(), waiting: record.loaded === undefined };
    record.stream = stream;
    if (stream.waiting) this.#publish(record, false, true, null, false);
    const publish = (value: unknown): boolean => {
      if (!this.#active || record.stream !== stream || stream.abort.signal.aborted || this.#port.supplied(record.name)) return false;
      const current = this.#currentSelection(record, selection.input!.key);
      if (current?.stream?.input?.key !== stream.key || !current.stream.status.ready || current.stream.status.stale || current.stream.failure !== undefined) return false;
      if (!this.#commit(record, value, this.#valueStatus(current))) { this.#fail(record, { name: "TypeError", message: `Binding ${record.name} produced a value outside its declared type.` }); return false; }
      record.loaded = selection.input!.key;
      record.error = undefined;
      stream.waiting = false;
      return true;
    };
    const accept = (cleanup: void | (() => void)): void => {
      if (cleanup !== undefined && typeof cleanup !== "function") throw new TypeError("A binding subscription must return cleanup or undefined.");
      if (cleanup === undefined) return;
      if (record.stream !== stream || stream.abort.signal.aborted) this.#cleanup(cleanup);
      else stream.cleanup = cleanup;
    };
    try {
      const sample = this.#sample(record);
      const context = { ...this.#operation(stream.abort.signal, sample), publish };
      const result = typeof config === "function" ? config(structuredClone(input.value), context) : config.open(structuredClone(input.value), context);
      void Promise.resolve(result).then(accept).catch(error => {
        if (record.stream === stream && this.#active) { stream.waiting = false; stream.abort.abort(); this.#fail(record, failure(error)); }
      });
    } catch (error) { stream.waiting = false; stream.abort.abort(); this.#fail(record, failure(error)); }
  }
}

/** The binding library needs stable instance identity, not a DOM root or a server lifecycle hook. */
export interface BindingHost { readonly props: object }
export interface BindingConnection {
  readonly signal: AbortSignal;
  refresh(name: string): Promise<void>;
}
export interface BindingDefinition<H extends BindingHost = BindingHost> {
  readonly props?: BindingProviders;
  readonly connect?: (host: H, context: BindingConnection) => void | (() => void) | PromiseLike<void | (() => void)>;
}
export type BindingModule<H extends BindingHost = BindingHost> = BindingDefinition<H> & { readonly create?: never } |
  { readonly create: () => BindingDefinition<H>; readonly props?: never; readonly connect?: never };
type BrowserBindingOptions = Omit<BindingScopeOptions, "phase" | "signal">;
export interface BoundModuleOptions<H extends BindingHost> {
  /** Named replacement leaves unrelated providers and the component's interactions intact. */
  readonly overrides?: BindingProviders;
  readonly browser?: BrowserBindingOptions | ((host: H) => BrowserBindingOptions);
}
/** A completed preparation's transfer identities and its remaining ownership. */
export interface BindingPreparation {
  /** Outputs owned by this preparation, including reads deferred to the browser. */
  readonly names: readonly string[];
  snapshot(): BindingSnapshot;
  dispose(): void;
}

/**
 * An ordinary named-connect adapter. HTMLKit may generate this wrapper around a source module;
 * standalone authors may export its connect themselves. Preparation never calls browser behavior.
 */
export function bindModule<H extends BindingHost>(module: BindingModule<H>, options: BoundModuleOptions<H> = {}): {
  connect(host: H, context: { readonly signal: AbortSignal }): void | (() => void) | Promise<void | (() => void)>;
  prepare(host: H, options: Omit<BindingScopeOptions, "phase"> & { readonly phase: "build" | "request" }): Promise<BindingPreparation>;
} {
  interface Instance { readonly definition: BindingDefinition<H>; scope?: BindingScope; activation?: object | undefined }
  const instances = new WeakMap<object, Instance>();
  const instance = (host: H): Instance => {
    const previous = instances.get(host.props);
    if (previous !== undefined) return previous;
    if (module.create !== undefined && (typeof module.create !== "function" || module.props !== undefined || module.connect !== undefined)) {
      throw new TypeError("A binding module exports create, or props and connect; do not mix the two forms.");
    }
    const definition = module.create === undefined ? module : synchronous(module.create(), "A binding create factory");
    if (definition === null || typeof definition !== "object" || Array.isArray(definition) ||
      "connect" in definition && definition.connect !== undefined && typeof definition.connect !== "function" ||
      "props" in definition && definition.props !== undefined && (definition.props === null || typeof definition.props !== "object" || Array.isArray(definition.props))) {
      throw new TypeError("A binding module must provide { props, connect } synchronously.");
    }
    const current: Instance = { definition: definition as BindingDefinition<H> };
    instances.set(host.props, current);
    return current;
  };
  const providers = (current: Instance): BindingProviders => ({ ...current.definition.props, ...options.overrides });
  return {
    connect(host, { signal }) {
      if (signal.aborted) throw signal.reason;
      const current = instance(host);
      if (Object.keys(providers(current)).length === 0) {
        const result = current.definition.connect?.(host, { signal, refresh: async () => {} });
        return result !== undefined && typeof result !== "function" ? Promise.resolve(result) : result;
      }
      if (current.activation !== undefined) throw new TypeError("This binding module is already connected.");
      const browser = current.scope === undefined ? typeof options.browser === "function" ? options.browser(host) : options.browser : undefined;
      const scope = current.scope ??= new BindingScope(componentInputs(host), providers(current), { ...browser, phase: "browser" });
      const activation = {};
      current.activation = activation;
      try { scope.activate(componentInputs(host), signal); }
      catch (error) { current.activation = undefined; throw error; }
      const aborted = (): void => { if (current.activation === activation) current.activation = undefined; };
      signal.addEventListener("abort", aborted, { once: true });
      const stop = (cleanup?: () => void): (() => void) => {
        let stopped = false;
        return () => {
          if (stopped) return;
          stopped = true;
          signal.removeEventListener("abort", aborted);
          if (current.activation === activation) { current.activation = undefined; scope.deactivate(); }
          cleanup?.();
        };
      };
      const accept = (cleanup: void | (() => void)): (() => void) => {
        if (cleanup !== undefined && typeof cleanup !== "function") throw new TypeError("A binding connect must return cleanup or undefined.");
        return stop(cleanup ?? undefined);
      };
      const failed = (error: unknown): never => { stop()(); throw error; };
      try {
        const result = current.definition.connect?.(host, { signal, refresh: name =>
          signal.aborted ? Promise.reject(signal.reason) : scope.refresh(name) });
        if (result !== undefined && typeof result !== "function") return Promise.resolve(result).then(accept).catch(failed);
        return accept(result);
      } catch (error) { return failed(error); }
    },
    async prepare(host, preparation) {
      const configured = providers(instance(host));
      if (preparation.signal?.aborted) throw preparation.signal.reason;
      if (Object.keys(configured).length === 0) {
        if (preparation.source !== undefined && (typeof preparation.source !== "string" || preparation.source.trim() === "")) throw new TypeError("A binding source revision must be a nonempty string.");
        return { names: [], snapshot: () => {
          if (preparation.source === undefined) throw new TypeError("A source revision is required to transfer binding completion identities.");
          return { source: preparation.source, reads: {} };
        }, dispose: () => {} };
      }
      const scope = new BindingScope(componentInputs(host), configured, preparation);
      try { scope.activate(); await scope.settled(); return scope; }
      catch (error) { scope.dispose(); throw error; }
    },
  };
}
