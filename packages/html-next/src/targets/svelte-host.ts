import type { GeneratedArtifact } from "../generate.js";
import { CONTROLLER_STATE_SOURCE } from "./controller-state-source.js";

const SOURCE = `import { flushSync, untrack } from "svelte";
import { cycleCheckedComputed } from "./reactivity.svelte";

import { observeConnection } from "./connection.svelte";

export interface StateAccess {
  readonly get: () => unknown;
  readonly set: (value: unknown) => void;
}

export interface ComponentHostOptions {
  readonly root: () => Element | null;
  readonly ownsRoot: () => boolean;
  readonly definition: string;
  readonly tag: string;
  readonly controller: string;
  readonly props: () => Readonly<Record<string, unknown>>;
  readonly propInputs?: (name: string) => unknown;
  readonly propValidity?: (name: string) => unknown;
  readonly propNames?: readonly string[];
  readonly state: Readonly<Record<string, StateAccess>>;
  readonly computed: Readonly<Record<string, () => unknown>>;
  readonly refs: Map<string, Element | Element[]>;
  readonly dispatch: (root: Element, name: string, detail?: unknown) => boolean;
  readonly data?: Readonly<Record<string, () => unknown>>;
  readonly acceptsState?: (name: string, keys: readonly string[], value: unknown) => boolean;
}

interface ControllerHost {
  readonly root: Element;
  readonly element: Element;
  readonly state: Record<string, unknown>;
  readonly data: Readonly<Record<string, unknown>>;
  readonly props: Readonly<Record<string, {
    readonly value: unknown;
    readonly inputValue: unknown;
    readonly validity: unknown;
    validate(): unknown;
  }>>;
  readonly refs: Readonly<Record<string, Element | readonly Element[]>>;
  readonly slots: Readonly<Record<string, readonly Element[]>>;
  signal<T>(initial: T): { get(): T; set(value: T): void; update(update: (value: T) => T): void };
  computed<T>(compute: () => T): { get(): T };
  effect(run: () => void | (() => void)): () => void;
  dispatch(name: string, detail?: unknown): boolean;
  on(type: string, callback: EventListener): () => void;
}

interface ControllerModule {
  readonly default: (host: ControllerHost) => void | (() => void) | Promise<void | (() => void)>;
}

function moduleDiagnostic(code: "HJ001" | "HJ002", options: ComponentHostOptions, reason?: unknown): Error {
  const base = typeof document === "undefined" ? options.definition : new URL(options.definition, document.baseURI).href;
  const url = new URL(options.controller, base).href;
  const tick = String.fromCharCode(96);
  const message = code === "HJ002"
    ? "Controller module " + tick + url + tick + " must default-export a function."
    : "Controller module " + tick + url + tick + " failed to load: " + (reason instanceof Error ? reason.message : String(reason)) + ".";
  return Object.assign(new Error(base + ": " + code + ": " + message), {
    name: "HtmlDiagnosticError", diagnostic: Object.freeze({ code, message, source: base }),
  });
}

function documentOrder(elements: readonly Element[]): Element[] {
  return [...elements].filter((element) => element.isConnected)
    .sort((left, right) => left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_PRECEDING ? 1 : -1);
}

${CONTROLLER_STATE_SOURCE}

/** Public Svelte runes own reactions; native DOM connectivity owns controller lifetimes. */
export function useComponentHost(loader: () => Promise<unknown>, options: ComponentHostOptions): void {
  let controllerModule: Promise<ControllerModule> | undefined;
  let started: Promise<ControllerModule> | undefined;
  let cleanup: void | (() => void);
  let connected = $state(false);
  let root = $state.raw<Element | null>(null);
  let lastRoot: Element | null = null;
  let generation = 0;
  let initialized = false;
  let membership = $state(0);
  const effects = new Map<() => void, () => void>();
  const subscriptions = new Set<{ type: string; callback: EventListener; cleanup?: () => void }>();
  const connect = (subscription: { callback: EventListener; cleanup?: () => void }): void => {
    const result = (subscription.callback as (event: Event) => unknown)(new Event("connect"));
    if (typeof result === "function") subscription.cleanup = result as () => void;
  };
  const report = (error: unknown): void => { queueMicrotask(() => { throw error; }); };
  const propHandles = Object.create(null) as Record<string, ControllerHost["props"][string]>;
  for (const name of options.propNames ?? []) {
    const validity = (): unknown => options.propValidity?.(name);
    propHandles[name] = Object.freeze({
      get value() { return options.props()[name]; },
      get inputValue() { return options.propInputs?.(name); },
      get validity() { return validity(); },
      validate: validity,
    });
  }
  const host: ControllerHost = {
    get root() { return (root ?? lastRoot)!; },
    get element() { return host.root; },
    ...controllerNamespaces(options, options.definition),
    props: Object.freeze(propHandles),
    refs: new Proxy({} as Record<string, Element | readonly Element[]>, {
      get: (_target, name) => {
        if (typeof name !== "string") return undefined;
        const recorded = options.refs.get(name);
        if (!Array.isArray(recorded)) return recorded;
        const live = documentOrder(recorded);
        if (live.length !== recorded.length) options.refs.set(name, live);
        return live;
      },
      has: (_target, name) => typeof name === "string" && options.refs.has(name),
    }),
    slots: new Proxy({} as Record<string, readonly Element[]>, {
      get: (_target, name) => {
        if (typeof name !== "string") return undefined;
        void membership;
        const current = host.root;
        const slot = name === "default" ? "" : name;
        return Array.from(current.querySelectorAll("[data-slotted]"))
          .filter((element) => element.parentElement?.closest("[data-component]") === current &&
            (element.getAttribute("slot") ?? "") === slot);
      },
      has: (_target, name) => typeof name === "string" && host.slots[name]!.length > 0,
    }),
    signal<T>(initial: T) {
      let value = $state.raw(initial);
      const set = (next: T): void => { value = next; };
      return { get: () => value, set, update: (update: (value: T) => T) => set(update(value)) };
    },
    computed<T>(compute: () => T) {
      let previous!: T;
      return cycleCheckedComputed(() => { if (connected) previous = compute(); return previous; });
    },
    effect(run) {
      let stopped = false;
      let cleanupEffect: void | (() => void);
      const pause = (): void => { const cleanup = cleanupEffect; cleanupEffect = undefined; cleanup?.(); };
      const dispose = $effect.root(() => {
        $effect(() => {
          if (connected) { cleanupEffect = run(); return pause; }
        });
      });
      const stop = (): void => {
        if (stopped) return;
        stopped = true;
        dispose();
        effects.delete(stop);
      };
      effects.set(stop, pause);
      if (!$effect.tracking()) flushSync();
      return stop;
    },
    dispatch: (name, detail) => options.dispatch(host.root, name, detail),
    on(type, callback) {
      const subscription: { type: string; callback: EventListener; cleanup?: () => void } = { type, callback };
      subscriptions.add(subscription);
      if (type === "connect") { if (connected) connect(subscription); }
      else if (type !== "disconnect" && connected) host.root.addEventListener(type, callback);
      return () => {
        if (!subscriptions.delete(subscription)) return;
        if (type !== "connect" && type !== "disconnect") host.root.removeEventListener(type, callback);
        subscription.cleanup?.();
        subscription.cleanup = undefined;
      };
    },
  };
  Object.freeze(host);
  const load = (): Promise<ControllerModule> => controllerModule ??= Promise.resolve().then(loader).then((candidate) => {
    if (typeof (candidate as { default?: unknown } | null)?.default !== "function") throw moduleDiagnostic("HJ002", options);
    return candidate as ControllerModule;
  }).catch((error: unknown) => {
    if (error instanceof Error && "diagnostic" in error) throw error;
    throw moduleDiagnostic("HJ001", options, error);
  });
  const disconnect = (): void => {
    if (!connected) return;
    connected = false;
    generation += 1;
    for (const subscription of [...subscriptions]) {
      if (subscription.type === "disconnect") subscription.callback(new Event("disconnect"));
    }
    for (const subscription of [...subscriptions]) {
      if (subscription.type !== "connect" && subscription.type !== "disconnect") host.root.removeEventListener(subscription.type, subscription.callback);
      const dispose = subscription.cleanup; subscription.cleanup = undefined; dispose?.();
    }
    for (const pause of [...effects.values()]) pause();
    cleanup?.();
    cleanup = undefined;
  };
  const synchronize = (): void => {
    const next = options.root();
    if (root !== next) {
      // Connected root-arm replacement transfers the same logical controller lifetime.
      if (!(connected && next?.isConnected === true)) disconnect();
      if (connected && root !== null) for (const subscription of subscriptions) {
        if (subscription.type !== "connect" && subscription.type !== "disconnect") {
          root.removeEventListener(subscription.type, subscription.callback);
          next!.addEventListener(subscription.type, subscription.callback);
        }
      }
      root = next;
      if (next !== null) lastRoot = next;
    }
    if (next?.isConnected !== true) { disconnect(); return; }
    if (connected) return;
    connected = true;
    const current = ++generation;
    if (initialized) {
      for (const subscription of [...subscriptions]) {
        if (subscription.type === "connect") connect(subscription);
        else if (subscription.type !== "disconnect") next.addEventListener(subscription.type, subscription.callback);
      }
      return;
    }
    started = load().then(async (module) => {
      if (!connected || current !== generation) return module;
      initialized = true;
      const result = await module.default(host);
      if (typeof result === "function") {
        if (!connected || current !== generation) result();
        else cleanup = result;
      }
      return module;
    });
    void started.catch(report);
  };
  $effect(() => {
    if (!options.ownsRoot()) { untrack(disconnect); return; }
    const element = options.root();
    untrack(synchronize);
    if (element === null) return;
    return observeConnection(element, () => untrack(() => { membership += 1; synchronize(); }));
  });
  $effect(() => () => untrack(() => {
    disconnect();
    for (const stop of [...effects.keys()]) stop();
    subscriptions.clear();
  }));
}
`;

export function svelteHostArtifact(version: string): GeneratedArtifact {
  return Object.freeze({ path: "svelte/host.svelte.ts", content: `// Generated by HTML Next ${version}. Do not edit.\n${SOURCE}` });
}
