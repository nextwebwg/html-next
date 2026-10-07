/**
 * The one module every converted Vue component shares: the controller host and the event dispatcher.
 * Both are the same for every component, so they ship once beside the components rather than being
 * repeated in each `<script setup>`; only a component's own values, refs, and event types are
 * generated. It depends on Vue alone.
 */
import { formatVue } from "./vue-format.js";
import { DISPATCH_TARGETS_SOURCE, DATA_URL_SOURCE } from "./shared-generated.js";
import { CONTROLLER_STATE_SOURCE } from "./controller-state-source.js";

/** Where the shared module sits, relative to the package root, and how a component imports it. */
export const VUE_HOST_PATH = "vue/host.ts";
export const VUE_HOST_SPECIFIER = "./host";

/** Whether a converted component imports the shared module, so a build knows to ship it. */
export function importsVueHost(source: string): boolean {
  return new RegExp(`from ['"]${VUE_HOST_SPECIFIER}['"]`).test(source);
}

const SOURCE = `
import { computed, Fragment, getCurrentInstance, onBeforeUnmount, onBeforeUpdate, onMounted, onUpdated, shallowRef, useSlots, watch, watchEffect } from "vue";

${CONTROLLER_STATE_SOURCE}
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
  const update = (sources: readonly unknown[]): void => {
    if (sources.includes(Symbol.for("html-next.invalid-result"))) return;
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

interface ConnectionHub {
  readonly observer: MutationObserver;
  readonly checks: Set<() => void>;
}

const connectionHubs = new WeakMap<Document, ConnectionHub>();

/** One native observer per document tracks externally detached controller roots. */
function observeConnection(element: Element, check: () => void): () => void {
  const document = element.ownerDocument;
  let hub = connectionHubs.get(document);
  if (hub === undefined) {
    const Observer = document.defaultView?.MutationObserver;
    if (Observer === undefined) throw new TypeError("Controller connection tracking requires MutationObserver.");
    const checks = new Set<() => void>();
    const observer = new Observer(() => { for (const current of checks) current(); });
    observer.observe(document, { childList: true, subtree: true });
    hub = { observer, checks };
    connectionHubs.set(document, hub);
  }
  hub.checks.add(check);
  return () => {
    hub.checks.delete(check);
    if (hub.checks.size === 0) {
      hub.observer.disconnect();
      connectionHubs.delete(document);
    }
  };
}

/** Keep native focus on the corresponding control when a root-level $match replaces its element. */
export function preserveRootFocus(root: Readable<Element | null>): void {
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
  /** The component's root element. */
  readonly root: Readable<HTMLElement | null>;
  /** Dispatches a declared component event. */
  readonly dispatch: (name: string, detail?: unknown) => boolean;
  /** The authored controller edge, retained for the live loader's module diagnostic. */
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
  readonly acceptsState?: (name: string, keys: readonly string[], value: unknown) => boolean;
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
  const { root, dispatch, props, propInputs = () => null, propNames = [], refs = {}, state = {}, computed: computedValues = {}, data = {}, context = {} } = options;
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
      ? "Controller module " + tick + url + tick + " must default-export a function."
      : "Controller module " + tick + url + tick + " failed to load: " + (reason instanceof Error ? reason.message : String(reason)) + ".";
    return Object.assign(new Error((source === undefined ? "" : source + ": ") + code + ": " + message), {
      name: "HtmlDiagnosticError", diagnostic: Object.freeze({ code, message, ...(source === undefined ? {} : { source }) }),
    });
  };
  type ControllerModule = Record<string, unknown> & { readonly default: (host: unknown) => unknown };
  let controllerModule: Promise<ControllerModule> | undefined;
  const loadControllerModule = (): Promise<ControllerModule> => controllerModule ??= Promise.resolve()
    .then(controllerLoader)
    .then((candidate) => {
      const loaded = candidate as { readonly default?: unknown } | null;
      if (typeof loaded?.default !== "function") throw controllerDiagnostic("HJ002");
      return candidate as ControllerModule;
    })
    .catch((error: unknown) => {
      if (error instanceof Error && "diagnostic" in error) throw error;
      throw controllerDiagnostic("HJ001", error);
    });
  const stops: Array<() => void> = [];
  const connected = shallowRef(false);
  const pauses = new Map<() => void, () => void>();
  const subscriptions = new Set<{ type: string; callback: (event: Event) => void | (() => void); target?: Element; cleanup?: void | (() => void) }>();
  type Subscription = typeof subscriptions extends Set<infer S> ? S : never;
  const activate = (entry: Subscription): void => {
    if (entry.type === "connect") entry.cleanup = entry.callback(new Event("connect"));
    else if (entry.type !== "disconnect") {
      entry.target = root.value ?? undefined;
      entry.target?.addEventListener(entry.type, entry.callback as EventListener);
    }
  };
  const deactivate = (entry: Subscription, disconnecting: boolean): void => {
    entry.target?.removeEventListener(entry.type, entry.callback as EventListener);
    entry.target = undefined;
    const cleanup = entry.cleanup; entry.cleanup = undefined; cleanup?.();
    if (disconnecting && entry.type === "disconnect") entry.callback(new Event("disconnect"));
  };
  const propHandles = Object.create(null) as Record<string, unknown>;
  for (const name of propNames) {
    const validity = () => options.propValidity?.(name);
    propHandles[name] = Object.freeze({
      get value() { return props?.value[name]; },
      get inputValue() { return propInputs(name); },
      get validity() { return validity(); },
      validate: validity,
    });
  }
  const host = {
    get element(): Element {
      return root.value as Element;
    },
    get root(): Element {
      return root.value as Element;
    },
    ...controllerNamespaces({
      state: Object.fromEntries(Object.entries(state).map(([name, value]) => [name, { get: () => value.value, set: (next: unknown) => { value.value = next; } }])),
      computed: Object.fromEntries([...Object.entries(computedValues), ...Object.entries(context)].map(([name, value]) => [name, () => value.value])),
      data: Object.fromEntries(Object.entries(data).map(([name, value]) => [name, () => value.value])),
      acceptsState: options.acceptsState,
    }, options.controllerSource?.definition ?? "<component>"),
    on(type: string, callback: (event: Event) => void | (() => void)): () => void {
      const entry: Subscription = { type, callback };
      subscriptions.add(entry);
      if (connected.value) activate(entry);
      return () => { if (subscriptions.delete(entry)) deactivate(entry, false); };
    },
    props: Object.freeze(propHandles),
    refs: Object.defineProperties(
      {},
      Object.fromEntries(
        Object.entries(refs).map(([name, ref]) => [name, {
          enumerable: true,
          get: () => Array.isArray(ref.value) ? inDocumentOrder(ref.value) : (ref.value as Element),
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
      const dispose = (): void => { stop(); pause(); pauses.delete(dispose); };
      pauses.set(dispose, pause);
      stops.push(dispose);
      return dispose;
    },
    dispatch,
  };

  let cleanup: void | (() => void);
  let started: Promise<ControllerModule> | undefined;
  let stopObserving: (() => void) | undefined;
  let connection = 0;
  let initialized = false;
  let unmounted = false;
  const disconnect = (): void => {
    if (!connected.value) return;
    connected.value = false;
    connection += 1;
    for (const pause of pauses.values()) pause();
    for (const entry of subscriptions) deactivate(entry, true);
    cleanup?.();
    cleanup = undefined;
  };
  const synchronize = (): void => {
    if (unmounted) return;
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
    if (initialized) return;
    const current = ++connection;
    started = loadControllerModule().then(async (loaded) => {
      if (!connected.value || current !== connection || initialized) return loaded;
      initialized = true;
      const result = await loaded.default(host as never);
      if (typeof result === "function") {
        if (!connected.value || current !== connection) result();
        else cleanup = result as () => void;
      }
      return loaded;
    });
    void started.catch(report);
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
  root: Readable<HTMLElement | null>,
  emit?: (name: string, detail: unknown) => void,
  options: DispatchOptions = {},
): (name: string, detail?: unknown, targets?: unknown) => boolean {
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
`;

/** The shared module's source, formatted the way the converted components are. */
export function vueHostModule(version: string): string {
  return formatVue(`// Generated by HTML Next ${version} for Vue 3.5. Do not edit.\n${SOURCE.trimStart()}`, "host.ts");
}
