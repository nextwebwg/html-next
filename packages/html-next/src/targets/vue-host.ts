/**
 * The one module every converted Vue component shares: the controller host, the event dispatcher,
 * and the helpers its templates render and bind values with. They are the same for every
 * component, so they ship once beside the components rather than being repeated in each
 * `<script setup>`; only a component's own values, refs, and event types are generated. It
 * depends on Vue alone.
 */
import { formatVue } from "./vue-format.js";
import { MODULE_CONNECTION_SOURCE } from "../generated/module-connection-source.js";
import { DISPATCH_TARGETS_SOURCE, DATA_URL_SOURCE, INPUT_STATUS_SOURCE } from "./shared-generated.js";
import { CONTROLLER_STATE_SOURCE } from "./controller-state-source.js";
import { NATIVE_CONNECTION_SOURCE } from "./native-connection-source.js";
import { REQUEST_HOST_SOURCE } from "./request-host-source.js";
import { expressionHelpersSource } from "./vue-lowering.js";

/** Where the shared module sits, relative to the package root, and how a component imports it. */
export const VUE_HOST_PATH = "vue/host.ts";
export const VUE_HOST_SPECIFIER = "./host";

/** Whether a converted component imports the shared module, so a build knows to ship it. */
export function importsVueHost(source: string): boolean {
  return new RegExp(`from ['"]${VUE_HOST_SPECIFIER}['"]`).test(source);
}

const SOURCE = `
import { computed, createCommentVNode, createTextVNode, customRef, defineComponent, Fragment, getCurrentInstance, h, inject, onBeforeUnmount, onBeforeUpdate, onMounted, onUpdated, ref, shallowRef, useSlots, watch, watchEffect } from "vue";
import type { PropType, Ref, VNode } from "vue";
${INPUT_STATUS_SOURCE}

${MODULE_CONNECTION_SOURCE}
${CONTROLLER_STATE_SOURCE}
${REQUEST_HOST_SOURCE}
${DISPATCH_TARGETS_SOURCE}

interface DataReadOptions {
  readonly source: string;
  readonly definition: string;
  readonly type?: string;
  readonly debounce?: number;
  readonly poll?: number;
  readonly sources: () => readonly unknown[];
  readonly parameters: () => Readonly<Record<string, unknown>>;
}

${DATA_URL_SOURCE}

/** A Vue-owned declared read; no request is made during SSR. */
export function useDataRead(state: { value: any }, options: DataReadOptions): void {
  let value: unknown = null;
  const acceptedParameters: Record<string, unknown> = {};
  let abort: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let generation = 0;
  let connected = false;
  let stop: (() => void) | undefined;
  const cancel = (): void => {
    abort?.abort();
    abort = undefined;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const stale = (current: number): boolean => !connected || current !== generation;
  const request = async (current: number): Promise<void> => {
    if (stale(current)) return;
    const controller = new AbortController();
    abort = controller;
    state.value = { pending: true, value, error: null, ok: false };
    try {
      const definition = (() => {
        try { return new URL(options.definition, document.baseURI).href; }
        catch { return document.baseURI; }
      })();
      const sampled = options.parameters();
      const parameters = Object.fromEntries(Object.entries(sampled).map(([name, input]) => {
        if (input === Symbol.for("html-next.invalid-result")) return [name, acceptedParameters[name] ?? null];
        acceptedParameters[name] = input;
        return [name, input];
      }));
      const response = await fetch(dataURL(options.source, definition, parameters), { signal: controller.signal });
      if (!response.ok) throw new TypeError(\`Request failed with \${response.status}.\`);
      const next = options.type === "text" || options.type === "string" ? await response.text() : await response.json();
      if (stale(current)) return;
      value = next;
      state.value = { pending: false, value, error: null, ok: true };
    } catch (error) {
      if (controller.signal.aborted || stale(current)) return;
      state.value = { pending: false, value, error, ok: false };
    } finally {
      if (abort === controller) abort = undefined;
      if (!stale(current) && (options.poll ?? 0) > 0) {
        timer = setTimeout(() => { void request(current); }, options.poll);
      }
    }
  };
  let requested: string | undefined;
  const update = (sources: readonly unknown[]): void => {
    if (sources.includes(Symbol.for("html-next.invalid-result"))) return;
    // A deep watch fires on any write it reaches; only changed parameters request again.
    const key = dataKey(sources);
    if (connected && key === requested) return;
    requested = key;
    connected = true;
    cancel();
    const current = ++generation;
    if ((options.debounce ?? 0) > 0) timer = setTimeout(() => { void request(current); }, options.debounce);
    else void request(current);
  };
  onMounted(() => { stop = watch(options.sources, update, { immediate: true, deep: true }); });
  onBeforeUnmount(() => {
    stop?.();
    connected = false;
    generation += 1;
    cancel();
  });
}

/** A reactive value the host reads: Vue's ref, shallowRef, computed, and useTemplateRef all match. */
export interface Readable<T> {
  readonly value: T;
}

/** Vue refs a component invocation as its public instance; the ref is the root element it lowered to. */
function refElement(ref: any): Element {
  return ref == null || ref.nodeType === 1 ? ref : ref.$el;
}

/** The root ref as an element: a delegating component's root ref holds the invoked component. */
function rootElement<T extends Element>(root: Readable<T | null>): Readable<T | null> {
  return { get value() { return refElement(root.value) as T | null; } };
}

${NATIVE_CONNECTION_SOURCE}/**
 * Runs the root's on:connect and on:disconnect handlers each time it joins and leaves a document.
 * Vue hooks cover mount and unmount; the shared native observer sees the root detached and
 * reinserted outside Vue.
 */
export function useLifecycle(componentRoot: Readable<Element | null>, connect?: () => void, disconnect?: () => void): void {
  const root = rootElement(componentRoot);
  let connected = false;
  let stop: (() => void) | undefined;
  const synchronize = (): void => {
    if ((root.value?.isConnected === true) === connected) return;
    connected = !connected;
    (connected ? connect : disconnect)?.();
  };
  onMounted(() => {
    if (root.value !== null) stop = observeConnection(root.value, synchronize);
    synchronize();
  });
  onBeforeUnmount(() => {
    stop?.();
    if (connected) { connected = false; disconnect?.(); }
  });
}

/** Keep native focus on the corresponding control when a root-level $match replaces its element. */
export function preserveRootFocus(componentRoot: Readable<Element | null>): void {
  const root = rootElement(componentRoot);
  const focusable = "a[href], button, input, select, textarea, summary, [tabindex], [contenteditable]";
  let previous: Element | null = null;
  let active: Element | null = null;
  let focusIndex = -1;
  onBeforeUpdate(() => {
    previous = root.value;
    active = previous?.ownerDocument.activeElement ?? null;
    focusIndex = previous !== null && active !== null && active !== previous && previous.contains(active)
      ? Array.from(previous.querySelectorAll(focusable)).indexOf(active)
      : -1;
  });
  onUpdated(() => {
    const next = root.value;
    if (previous === null || next === null || previous === next) return;
    const target = active === previous ? next
      : active?.isConnected === true && next.contains(active) ? active
      : focusIndex >= 0 ? next.querySelectorAll(focusable)[focusIndex]
      : undefined;
    (target as HTMLElement | undefined)?.focus?.({ preventScroll: true });
  });
}

export interface ComponentHostOptions {
  readonly inputs?: { port(reactions: {
    readonly declarations?: Readonly<Record<string, { readonly read: () => unknown; readonly status: () => InputStatus }>>;
    track(name: string, kind: "value" | "status" | "supplied"): void;
    watch(run: () => void | (() => void)): () => void;
    untracked<T>(run: () => T): T;
  }): unknown };
  readonly availability?: Readonly<Record<string, () => InputStatus>>;
  readonly inputTracking?: {
    track(name: string, kind: "value" | "status" | "supplied"): void;
    untracked<T>(run: () => T): T;
  };
  /** The component's root element. */
  readonly root: Readable<HTMLElement | null>;
  /** Dispatches a declared component event. */
  readonly dispatch: (name: string, detail?: unknown) => boolean;
  /** The authored controller edge, retained for the live loader's module diagnostic. */
  readonly module?: boolean;
  readonly controllerSource?: { readonly specifier: string; readonly definition: string };
  /** Accepted component props, which a controller reads through \`host.props\`. */
  readonly props?: Readable<Readonly<Record<string, unknown>>>;
  /** Raw Vue prop inputs before the declared type is applied. */
  readonly propInputs?: (name: string) => unknown;
  readonly propNames?: readonly string[];
  readonly propValidity?: (name: string) => Readonly<Record<string, unknown>>;
  /** Template refs, by the ref name the component declared. Vue collects a \`v-for\` ref into an array. */
  readonly refs?: Readonly<Record<string, Readable<HTMLElement | HTMLElement[] | null>>>;
  /** Declared state, which a controller reads and writes. */
  readonly state?: Readonly<Record<string, { value: any }>>;
  /** Declared computed values, which a controller reads. */
  readonly computed?: Readonly<Record<string, Readable<unknown>>>;
  /** Declared data resources, which a controller reads. */
  readonly data?: Readonly<Record<string, Readable<unknown>>>;
  /** Values inherited through declared context, which a controller reads. */
  readonly context?: Readonly<Record<string, Readable<unknown>>>;
  /** Each named declared script, which a controller reads as \`host.scripts\`. */
  readonly scripts?: Readonly<Record<string, unknown>>;
  readonly acceptsState?: (name: string, keys: readonly string[], value: unknown) => boolean;
  readonly initials?: Readonly<Record<string, unknown>>;
  /** Asks one of the component's declared requests; its \`has\` builds \`host.hasResponder\`. */
  readonly request?: ((root: Element, connection: AbortSignal, name: string, detail?: unknown, options?: any) => Promise<unknown>)
    & { readonly has?: (host: any, own: string[]) => (name: string) => boolean };
  /** Each declared request's responder, from its function prop or event form, read when the request arrives. */
  readonly responders?: Readonly<Record<string, () => ((event: Event) => void) | undefined>>;
}

/** Vue does not promise a \`v-for\` ref array in source order, and the host does. */
function inDocumentOrder(elements: readonly Element[]): Element[] {
  return [...elements].sort((a, b) => (a.compareDocumentPosition(b) & 4) !== 0 ? -1 : 1);
}

/** Slot content flattened to the elements Vue mounted for it, descending through fragments. */
function slottedElements(nodes: readonly any[]): Element[] {
  const elements: Element[] = [];
  for (const node of nodes) {
    if (node.type === Fragment && Array.isArray(node.children)) elements.push(...slottedElements(node.children));
    else if (node.el instanceof Element) elements.push(node.el);
  }
  return elements;
}

/**
 * The controller host, built from Vue refs, effects, and lifecycle. Reads and writes reach the
 * component's own refs, so a controller's change renders as any other Vue change does. Vue
 * hooks cover mount/unmount; a shared native observer also detects external root detachment
 * and reinsertion without treating an in-tree move as a new connection.
 */
export function useComponentHost(
  controllerLoader: () => Promise<unknown>,
  options: ComponentHostOptions,
) {
  const root = rootElement(options.root);
  const { dispatch, props, propInputs = () => null, propNames = [], refs = {}, state = {}, computed: computedValues = {}, data = {}, context = {} } = options;
  const vueSlots = useSlots();
  const component = getCurrentInstance();
  const report = (error: unknown): void => {
    const handler = component?.appContext.config.errorHandler;
    if (handler === undefined) queueMicrotask(() => { throw error; });
    else handler(error, component?.proxy ?? null, "HTML Next controller");
  };
  const controllerDiagnostic = (code: "HJ001" | "HJ002", reason?: unknown): Error => {
    const edge = options.controllerSource;
    const source = edge?.definition ? new URL(edge.definition, document.baseURI).href : undefined;
    const url = new URL(edge?.specifier ?? "", source ?? document.baseURI).href;
    const tick = String.fromCharCode(96);
    const message = code === "HJ002"
      ? options.module ? "Component module " + tick + url + tick + " export connect must be a function." : "Controller module " + tick + url + tick + " must default-export a function."
      : "Controller module " + tick + url + tick + " failed to load: " + (reason instanceof Error ? reason.message : String(reason)) + ".";
    return Object.assign(new Error((source === undefined ? "" : source + ": ") + code + ": " + message), {
      name: "HtmlDiagnosticError", diagnostic: Object.freeze({ code, message, ...(source === undefined ? {} : { source }) }),
    });
  };
  type ControllerModule = Record<string, unknown> & { readonly default: (host: unknown) => unknown; readonly connect?: Connect<object> };
  let controllerModule: Promise<ControllerModule> | undefined;
  const loadControllerModule = (): Promise<ControllerModule> => controllerModule ??= Promise.resolve()
    .then(controllerLoader)
    .then((candidate) => {
      const loaded = candidate as { readonly default?: unknown; readonly connect?: unknown } | null;
      if (options.module ? loaded === null || typeof loaded !== "object" || loaded.connect !== undefined && typeof loaded.connect !== "function" : typeof loaded?.default !== "function") throw controllerDiagnostic("HJ002");
      return candidate as ControllerModule;
    })
    .catch((error: unknown) => {
      if (error instanceof Error && "diagnostic" in error) throw error;
      throw controllerDiagnostic("HJ001", error);
    });
  const stops: Array<() => void> = [];
  const connected = shallowRef(false);
  const pauses = new Map<() => void, () => void>();
  // A subscription's known responder (k), and for a request's function prop or event form whether one is set (r).
  const subscriptions = new Set<{
    type: string; callback: (event: Event) => void | (() => void); target?: Element | undefined; cleanup?: void | (() => void);
    k?: (() => void) | undefined; r?: () => boolean;
  }>();
  type Subscription = typeof subscriptions extends Set<infer S> ? S : never;
  // How many known responders the controller's host.on keeps on its own root, by name.
  const own: string[] = [];
  const track = (entry: Subscription): void => {
    entry.k?.();
    entry.k = entry.target === undefined || entry.r?.() === false ? undefined : knownResponder(entry.target, entry.type, entry.r ? undefined : own);
  };
  const activate = (entry: Subscription): void => {
    if (entry.type === "connect") entry.cleanup = entry.callback(new Event("connect"));
    else if (entry.type !== "disconnect") {
      entry.target = root.value ?? undefined;
      entry.target?.addEventListener(entry.type, entry.callback as EventListener);
      track(entry);
      // A responder registered after a request went unanswered tells the asker to ask again.
      if (entry.target !== undefined) relayResponders(entry.target, entry.type);
    }
  };
  const deactivate = (entry: Subscription, disconnecting: boolean): void => {
    entry.target?.removeEventListener(entry.type, entry.callback as EventListener);
    entry.target = undefined;
    track(entry);
    const cleanup = entry.cleanup; entry.cleanup = undefined; cleanup?.();
    if (disconnecting && entry.type === "disconnect") entry.callback(new Event("disconnect"));
  };
  const propHandles = Object.create(null) as Record<string, unknown>;
  for (const name of propNames) {
    const validity = () => options.propValidity?.(name);
    // One computed per prop: a reader of this prop does not run again when another prop changes.
    const value = computed(() => props?.value[name]);
    propHandles[name] = Object.freeze({
      get value() { return value.value; },
      get inputValue() { return propInputs(name); },
      get validity() { return validity(); },
      validate: validity,
    });
  }
  // Vue clears a template ref when it removes the element, as when a failed render replaces the
  // root, so cleanup that runs after that still reads the root that disconnected.
  let lastRoot: Element | null = null;
  const host = {
    get [Symbol.for("@nextwebwg/html-next.inputs.v1")](): unknown {
      return options.inputs?.port({
        declarations: Object.fromEntries([...Object.keys(state), ...Object.keys(computedValues), ...Object.keys(context)].map(name => [name, {
          read: () => host.state[name], status: () => options.availability?.[name]?.() ?? READY_INPUT,
        }])),
        track: (name, kind) => options.inputTracking!.track(name, kind),
        // Input sources own their subscriptions, including preparation before DOM connection.
        watch: run => watchEffect(run, { flush: "post" }),
        untracked: run => options.inputTracking!.untracked(run),
      });
    },
    get element(): Element {
      return (root.value ?? lastRoot) as Element;
    },
    get root(): Element {
      return (root.value ?? lastRoot) as Element;
    },
    ...controllerNamespaces({
      state: Object.fromEntries(Object.entries(state).map(([name, value]) => [name, { get: () => value.value, set: (next: unknown) => { value.value = next; } }])),
      computed: Object.fromEntries([...Object.entries(computedValues), ...Object.entries(context)].map(([name, value]) => [name, () => value.value])),
      data: Object.fromEntries(Object.entries(data).map(([name, value]) => [name, () => value.value])),
      ...(options.acceptsState === undefined ? {} : { acceptsState: options.acceptsState }),
      ...(options.initials === undefined ? {} : { initials: options.initials }),
    }, options.controllerSource?.definition ?? "<component>"),
    scripts: options.scripts ?? Object.freeze({}),
    on(type: string, callback: (event: Event) => void | (() => void)): () => void { return listen(type, callback); },
    props: Object.freeze(propHandles),
    refs: Object.defineProperties(
      {},
      Object.fromEntries(
        Object.entries(refs).map(([name, ref]) => [name, {
          enumerable: true,
          get: () => Array.isArray(ref.value) ? inDocumentOrder(ref.value.map(refElement)) : refElement(ref.value),
        }]),
      ),
    ) as Readonly<Record<string, Element | readonly Element[]>>,
    slots: new Proxy({} as Record<string, readonly Element[]>, {
      get: (_target, name) => {
        if (typeof name !== "string") return undefined;
        const render = vueSlots[name];
        return render === undefined ? [] : slottedElements(render());
      },
      has: (_target, name) => typeof name === "string" && vueSlots[name] !== undefined,
    }),
    signal<T>(initialValue: T) {
      // shallowRef holds the controller's own value and notifies only when it changes.
      const value = shallowRef(initialValue);
      return {
        get: (): T => value.value,
        set: (next: T): void => {
          value.value = next;
        },
        update: (next: (current: T) => T): void => {
          value.value = next(value.value);
        },
      };
    },
    computed<T>(compute: () => T) {
      const value = computed(compute);
      return { get: (): T => value.value };
    },
    effect(run: () => void | (() => void)): () => void {
      let cleanup: void | (() => void);
      const pause = (): void => { const previous = cleanup; cleanup = undefined; previous?.(); };
      const stop = watchEffect(() => {
        pause();
        if (connected.value) cleanup = run();
      }, { flush: "post" });
      const dispose = (): void => { stop(); pause(); pauses.delete(dispose); const index = stops.indexOf(dispose); if (index >= 0) stops.splice(index, 1); };
      pauses.set(dispose, pause);
      stops.push(dispose);
      return dispose;
    },
    dispatch,
    // A component that declares requests also has host.request.
    ...(options.request === undefined ? {} : {
      request: (name: string, detail?: unknown, requestOptions?: unknown): Promise<unknown> =>
        options.request!(root.value as Element, requests.signal(connected.value), name, detail, requestOptions),
    }),
  };
  function listen(type: string, callback: (event: Event) => void | (() => void), set?: () => boolean): () => void {
    const entry: Subscription = { type, callback: type === "connect" || type === "disconnect" || options.request === undefined ? callback : hostListener(type, callback) };
    if (set !== undefined) entry.r = set;
    subscriptions.add(entry);
    if (connected.value) activate(entry);
    return () => { if (subscriptions.delete(entry)) deactivate(entry, false); };
  }
  if (options.request?.has !== undefined) Object.assign(host, { hasResponder: options.request.has(host, own) });
  const requests = requestConnection();
  // Each request's responder listens on the root from its first connection, before the controller runs.
  const responders = Object.entries(options.responders ?? {});
  for (const [name, read] of responders) listen(name, (event) => read()?.(event), () => read() !== undefined);
  // A function prop or event form set later is a known responder, and relays for its request, as a late host.on does.
  if (responders.length > 0) {
    watch(() => responders.map(([, read]) => read() !== undefined), (now, before) => {
      for (const entry of subscriptions) if (entry.r !== undefined) track(entry);
      const element = root.value;
      if (element === null || !connected.value) return;
      now.forEach((set, index) => { if (set && !before[index]) relayResponders(element, responders[index]![0]); });
    });
  }

  let cleanup: void | (() => void);
  let started: Promise<ControllerModule> | undefined;
  let stopObserving: (() => void) | undefined;
  let connection = 0;
  let initialized = false;
  let unmounted = false;
  let releaseController: (() => void) | undefined;
  const disconnect = (): void => {
    if (!connected.value) return;
    connected.value = false;
    connection += 1;
    requests.end();
    releaseController?.();
    for (const pause of pauses.values()) pause();
    for (const entry of subscriptions) deactivate(entry, true);
    cleanup?.();
    cleanup = undefined;
  };
  const synchronize = (): void => {
    if (unmounted) return;
    lastRoot = root.value ?? lastRoot;
    if (root.value?.isConnected !== true) {
      disconnect();
      return;
    }
    if (connected.value) {
      for (const entry of subscriptions) {
        if (entry.type !== "connect" && entry.type !== "disconnect" && entry.target !== root.value) {
          deactivate(entry, false); activate(entry);
        }
      }
      return;
    }
    connected.value = true;
    for (const entry of subscriptions) activate(entry);
    if (initialized && !options.module) return;
    const current = ++connection;
    // Requests from inside this root wait until the controller has run, or failed to load.
    const release = releaseController = holdController(root.value!);
    started = loadControllerModule().then(async (loaded) => {
      if (!connected.value || current !== connection || initialized && !options.module) return loaded;
      initialized = true;
      if (options.module) {
        try { cleanup = activateModule(loaded, host, report); } finally { release(); }
        return loaded;
      }
      let invoked: unknown;
      try { invoked = loaded.default(host as never); } finally { release(); }
      const result = await invoked;
      if (typeof result === "function") {
        if (!connected.value || current !== connection) result();
        else cleanup = result as () => void;
      }
      return loaded;
    });
    void started.catch(report).finally(release);
  };
  onMounted(() => {
    if (root.value === null) return;
    stopObserving = observeConnection(root.value, () => {
      try { synchronize(); } catch (error) { report(error); }
    });
    synchronize();
  });
  onUpdated(synchronize);
  onBeforeUnmount(() => {
    unmounted = true;
    stopObserving?.();
    disconnect();
    for (const stop of stops.splice(0)) stop();
    subscriptions.clear();
  });
  return host;
}

export interface DispatchOptions {
  /** Each declared event's bubbles, composed, and cancelable. */
  readonly declared?: Readonly<Record<string, EventInit>>;
  /** Each declared event's detail check, from its declared type. */
  readonly checks?: Readonly<Record<string, (detail: unknown) => boolean>>;
  /** Props an event's detail reports, which also emit \`update:<prop>\` for \`v-model:<prop>\`. */
  readonly modeled?: readonly string[];
}

class HtmlDiagnosticError extends Error {
  readonly diagnostic: Readonly<{ code: string; message: string }>;

  constructor(code: string, message: string) {
    super(code + ": " + message);
    this.name = "HtmlDiagnosticError";
    this.diagnostic = Object.freeze({ code, message });
  }
}

/** Apply HTML Next's event filters before propagation/cancellation actions on the original DOM event. */
export function runFilteredEvent(event: Event, modifiers: readonly string[], handler: () => void): void {
  if (modifiers.includes("self") && event.target !== event.currentTarget) return;
  if (event instanceof MouseEvent) {
    const buttons: Record<string, number> = { left: 0, middle: 1, right: 2 };
    const filters = modifiers.filter((modifier) => modifier in buttons);
    if (filters.length > 0 && !filters.some((filter) => event.button === buttons[filter])) return;
  }
  const systemKeys = ["ctrl", "shift", "alt", "meta"] as const;
  for (const key of systemKeys) {
    if (modifiers.includes(key) && !(event as unknown as Record<string, boolean>)[key + "Key"]) return;
  }
  if (modifiers.includes("exact") && systemKeys.some((key) =>
    !modifiers.includes(key) && (event as unknown as Record<string, boolean>)[key + "Key"],
  )) return;
  if (event instanceof KeyboardEvent) {
    const names: Record<string, string> = {
      enter: "Enter", escape: "Escape", space: " ", tab: "Tab",
      up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight",
    };
    const filters = modifiers.filter((modifier) => modifier in names);
    if (filters.length > 0 && !filters.some((filter) => event.key === names[filter])) return;
  }
  if (modifiers.includes("prevent")) event.preventDefault();
  if (modifiers.includes("stop")) event.stopPropagation();
  handler();
}

/** Reports declared CustomEvents to Vue and dispatches them through the DOM. */
export function createDispatch(
  componentRoot: Readable<HTMLElement | null>,
  emit?: (name: string, detail: unknown) => void,
  options: DispatchOptions = {},
): (name: string, detail?: unknown, targets?: unknown) => boolean {
  const root = rootElement(componentRoot);
  const { declared = {}, checks = {}, modeled = [] } = options;
  // One change can be reported by more than one event — a choice is both a select and a change —
  // and each carries the new value. The prop updates once per change: a value already reported in
  // this turn of the event loop is not reported again.
  const reported = new Map<string, unknown>();
  return (name, detail, targets) => {
    const check = checks[name];
    if (detail !== undefined && check !== undefined && !check(detail)) {
      throw new HtmlDiagnosticError("HR002", \`Event \\\`\${name}\\\` detail does not satisfy its declared type.\`);
    }
    if (targets !== undefined) {
      let accepted = true;
      dispatchToTargets(targets, target => {
        if (!target.dispatchEvent(new CustomEvent(name, { bubbles: true, composed: true, ...declared[name], detail }))) accepted = false;
      });
      return accepted;
    }
    if (detail !== null && typeof detail === "object") {
      for (const prop of modeled) {
        if (!(prop in detail)) continue;
        const value = (detail as Record<string, unknown>)[prop];
        if (reported.has(prop) && Object.is(reported.get(prop), value)) continue;
        if (reported.size === 0) queueMicrotask(() => reported.clear());
        reported.set(prop, value);
        emit?.(\`update:\${prop}\`, value);
      }
    }
    const event = new CustomEvent(name, { bubbles: true, composed: true, ...declared[name], detail });
    if (check !== undefined) emit?.(name, event);
    return root.value?.dispatchEvent(event) ?? true;
  };
}

/**
 * A consumer's attributes for the root. Vue sets a name that is also an object property, such as
 * \`constructor\`, as a DOM property; capitalized, it stays an attribute, which HTML lowercases.
 */
export function nativeAttrs(attrs: Record<string, unknown>): Record<string, unknown> {
  const names = Object.keys(attrs);
  if (!names.some((name) => Object.hasOwn(Object.prototype, name))) return attrs;
  return Object.fromEntries(names.map((name) => [
    Object.hasOwn(Object.prototype, name) ? name === "__proto__" ? "__Proto__" : name[0]!.toUpperCase() + name.slice(1) : name,
    attrs[name],
  ]));
}

/** Hydrating server markup needs its root to be the element this component renders. */
export function checkHydratedRoot(expected: string | undefined, tag: string): void {
  const node = getCurrentInstance()?.vnode.el;
  if (typeof window === "undefined" || node == null || node instanceof Element && node.localName === expected) return;
  const message = \`Server markup for <\${tag}> has an incompatible root.\`;
  throw Object.assign(new Error(\`HR005: \${message}\`), { name: "HtmlDiagnosticError", diagnostic: Object.freeze({ code: "HR005", message }) });
}

function diagnostic(code: string, message: string): Error {
  return Object.assign(new Error(\`\${code}: \${message}\`), { name: "HtmlDiagnosticError", diagnostic: Object.freeze({ code, message }) });
}

/** A component's context value from the ancestor that provides it; a missing provider is an error. */
export function injectContext(tag: string, from: string, name: string): any {
  const value = inject<any>(\`html-next:\${from}:\${name}\`);
  if (value === undefined) throw diagnostic("HR009", \`<\${tag}> requires context \\\`\${name}\\\` from <\${from}>.\`);
  return value;
}

/** Vue may return an in-progress computed value on a cyclic read; guard the public value access instead. */
export function cycleCheckedComputed<T>(evaluate: () => T) {
  const value = computed(evaluate);
  let reading = false;
  return new Proxy(value, {
    get(target, property) {
      if (property !== "value") return Reflect.get(target, property);
      if (reading) throw diagnostic("HR006", "A reactive computed value depends on itself.");
      reading = true;
      try { return target.value; } finally { reading = false; }
    },
  });
}

/** A Vue state cell owns its first usable seed or an earlier accepted edit, including equal writes. */
export function initializedState<T>(evaluate: () => { value: unknown; status: InputStatus }, accepts: (value: unknown) => boolean,
  copy: <V>(value: V) => V, warn: () => void): Ref<T | null | undefined> & { status(): InputStatus; start(): void } {
  const cell = ref<T>() as Ref<T | null | undefined>;
  let seed: ReturnType<typeof cycleCheckedComputed<ReturnType<typeof evaluate>>> | undefined = cycleCheckedComputed(evaluate);
  let initialized = false;
  let stop: (() => void) | undefined;
  let notify = () => {};
  const claim = (): void => {
    if (initialized) return;
    initialized = true;
    seed = undefined;
    // A claim can happen inside the seed watcher's read; release after Vue finishes tracking it.
    if (stop !== undefined) queueMicrotask(stop);
  };
  const initialize = (): void => {
    if (initialized) return;
    const next = seed!.value;
    if (!next.status.ready || next.status.stale || next.value === undefined) return;
    if (!accepts(next.value)) { warn(); return; }
    claim();
    cell.value = copy(next.value) as T;
    // The first usable seed may be claimed inside a computed read. Notify its
    // existing consumers after that read finishes, rather than re-entering it.
    queueMicrotask(notify);
  };
  const state = customRef<T | null | undefined>((track, trigger) => {
    notify = trigger;
    return {
      // Pending consumers track the custom ref and seed, not the unowned cell:
      // filling that cell must not synchronously invalidate an active computed.
      get() { track(); initialize(); return initialized ? cell.value : undefined; },
      set(value) {
        if (value != null && !accepts(value)) { warn(); return; }
        const first = !initialized;
        claim();
        cell.value = value ?? null;
        if (first) trigger();
      },
    };
  });
  return Object.assign(state, {
    status(): InputStatus {
      void state.value;
      return initialized ? cell.value === undefined ? { ...READY_INPUT, ready: false } : READY_INPUT
        : { ...seed!.value.status, ready: false, stale: false };
    },
    start() {
      if (initialized) return;
      stop = watchEffect(() => { void state.value; });
      if (initialized) stop();
    },
  });
}

/**
 * A declared prop's reflected root attribute: the authored literal until the consumer passes the
 * prop, then its value as text, absent for null.
 */
export function useReflectedProp() {
  const instance = getCurrentInstance();
  const structured = new Map<string, string | undefined>();
  return (name: string, kebab: string, value: unknown, fallback: string | undefined, bound: boolean, separator?: string): string | undefined => {
    const incoming = instance?.vnode.props;
    if (!bound && (incoming === null || incoming === undefined || (!Object.hasOwn(incoming, name) && !Object.hasOwn(incoming, kebab)))) return fallback;
    if (value === null || value === undefined) return undefined;
    // Hydration metadata keeps its initial structured input; rendering reads the current prop.
    // A binding authored on this attribute remains ordinary live template output.
    if (!bound && typeof value === "object" && structured.has(name)) return structured.get(name);
    const text = Array.isArray(value) && separator !== undefined ? value.join(separator) : typeof value === "object" ? JSON.stringify(value) : String(value);
    if (!bound && typeof value === "object") structured.set(name, text);
    return text;
  };
}

/** A scoped slot's name, which the consumer must fill with a \`<template slot>\` rather than plain children. */
export function useScopedSlotName() {
  const slots = useSlots();
  // A slot's name is a literal, so the outlet keeps its literal type, as declared slots type it.
  return <Name extends string>(name: Name): Name => {
    if (slots[name] === undefined && slots.default?.().some((node) => node.props?.slot === name)) {
      throw diagnostic("HR007", 'Scoped slot \`' + name + '\` requires a consumer <template slot="' + name + '">.');
    }
    return name;
  };
}

/** An inline text part that keeps its last accepted text while its value is invalid. */
export type InlineTextSegment = { readonly value: unknown; readonly text: string; readonly accepted: boolean };

export function inlineTextSegment(value: unknown, accepted: boolean, text: (value: any) => string): InlineTextSegment {
  return { value, accepted, text: accepted && value !== Symbol.for("html-next.invalid-result") ? text(value) ?? "" : "" };
}

export const RetainedInlineText = /* @__PURE__ */ defineComponent({
  props: { segments: { type: Array as PropType<InlineTextSegment[]>, required: true } },
  setup(props) {
    const previous: string[] = [];
    return () => {
      const text = props.segments.map((segment, index) => {
        if (segment.accepted && segment.value !== Symbol.for("html-next.invalid-result")) previous[index] = segment.text;
        return previous[index] ?? "";
      }).join("");
      // Empty text has no serialized SSR node; a comment preserves this component's hydration position.
      return text === "" ? createCommentVNode() : createTextVNode(text);
    };
  },
});

const KeyedFailure = /* @__PURE__ */ defineComponent({
  props: { error: { type: null, required: true } },
  setup(props) { return () => { throw props.error; }; },
});

/** A keyed list that produces a duplicate key keeps its last rows and reports the error in the browser. */
export const KeyedBoundary = /* @__PURE__ */ defineComponent({
  setup(_props, { slots }) {
    let last: VNode[] = [];
    return () => {
      try { last = slots.default?.() ?? []; return last; }
      catch (error) {
        if (!(error instanceof Error) || (error as Error & { diagnostic?: { code?: string } }).diagnostic?.code !== "HR004") throw error;
        if (typeof window === "undefined") throw error;
        return [...last, h(KeyedFailure, { error })];
      }
    };
  },
});
`;

/** Every name the shared module exports, which a component's own identifiers must not take. */
export const VUE_HOST_EXPORTS: readonly string[] = [...`${SOURCE}\n${expressionHelpersSource()}`
  .matchAll(/^export (?:const|function|class) ([\w$]+)/gm)].map((match) => match[1]!);

/** The shared module's source, formatted the way the converted components are. */
export function vueHostModule(version: string): string {
  return formatVue(`// Generated by HTML Next ${version} for Vue 3.5. Do not edit.\n${SOURCE.trimStart()}\n${expressionHelpersSource()}\n`, "host.ts");
}
