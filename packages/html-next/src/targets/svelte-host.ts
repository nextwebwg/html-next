import type { GeneratedArtifact } from "../generate.js";

const SOURCE = `import { flushSync, untrack } from "svelte";
import { cycleCheckedComputed } from "./reactivity.svelte";

import { observeConnection } from "./connection.svelte";

export interface StateAccess {
  readonly get: () => unknown;
  readonly set: (value: unknown) => void;
}

export interface ComponentHostOptions {
  readonly root: () => Element | null;
  readonly definition: string;
  readonly controller: string;
  readonly props: () => Readonly<Record<string, unknown>>;
  readonly propInputs?: (name: string) => unknown;
  readonly propValidity?: (name: string) => unknown;
  readonly propNames?: readonly string[];
  readonly state: Readonly<Record<string, StateAccess>>;
  readonly computed: Readonly<Record<string, () => unknown>>;
  readonly refs: ReadonlyMap<string, ReadonlySet<Element>>;
  readonly dispatch: (root: Element, name: string, detail?: unknown) => boolean;
  readonly methods: readonly { readonly name: string; readonly exportName: string }[];
}

interface ControllerHost {
  readonly root: Element;
  readonly element: Element;
  readonly state: Record<string, unknown>;
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
}

interface ControllerModule extends Record<string, unknown> {
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

function documentOrder(elements: ReadonlySet<Element>): Element[] {
  return [...elements].filter((element) => element.isConnected)
    .sort((left, right) => left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_PRECEDING ? 1 : -1);
}

/** Public Svelte runes own reactions; native DOM connectivity owns controller lifetimes. */
export function useComponentHost(loader: () => Promise<unknown>, options: ComponentHostOptions): {
  invoke(name: string, ...args: unknown[]): Promise<unknown>;
} {
  let controllerModule: Promise<ControllerModule> | undefined;
  let started: Promise<ControllerModule> | undefined;
  let cleanup: void | (() => void);
  let connected = $state(false);
  let root = $state.raw<Element | null>(null);
  let lastRoot: Element | null = null;
  let generation = 0;
  let membership = $state(0);
  const effects = new Map<() => void, () => void>();
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
    state: new Proxy({} as Record<string, unknown>, {
      get: (_target, name) => {
        if (typeof name !== "string") return undefined;
        if (Object.hasOwn(options.state, name)) return options.state[name]!.get();
        if (Object.hasOwn(options.computed, name)) return options.computed[name]!();
        return undefined;
      },
      set: (_target, name, value) => {
        if (typeof name !== "string" || !Object.hasOwn(options.state, name)) {
          const tick = String.fromCharCode(96);
          throw new TypeError("Only declared state roots are writable; " + tick + String(name) + tick + " is read-only.");
        }
        options.state[name]!.set(value);
        return true;
      },
      has: (_target, name) => typeof name === "string" &&
        (Object.hasOwn(options.state, name) || Object.hasOwn(options.computed, name)),
    }),
    props: Object.freeze(propHandles),
    refs: new Proxy({} as Record<string, Element | readonly Element[]>, {
      get: (_target, name) => {
        if (typeof name !== "string") return undefined;
        void membership;
        const elements = options.refs.get(name);
        if (elements === undefined) return undefined;
        const ordered = documentOrder(elements);
        return ordered.length === 1 ? ordered[0] : ordered;
      },
      has: (_target, name) => typeof name === "string" && options.refs.has(name),
    }),
    slots: new Proxy({} as Record<string, readonly Element[]>, {
      get: (_target, name) => {
        if (typeof name !== "string") return undefined;
        void membership;
        const current = host.root;
        return Array.from(current.querySelectorAll("[data-slotted]"))
          .filter((element) => element.parentElement?.closest("[data-component]") === current &&
            (element.getAttribute("slot") ?? "default") === name);
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
    for (const pause of [...effects.values()]) pause();
    cleanup?.();
    cleanup = undefined;
  };
  const invoke = (name: string, ...args: unknown[]): Promise<unknown> => {
    const method = options.methods.find((entry) => entry.name === name)!;
    if (started === undefined) return Promise.reject(new TypeError(
      "Controller method " + String.fromCharCode(96) + name + String.fromCharCode(96) +
      " is not ready for <" + host.root?.getAttribute("data-component") + ">.",
    ));
    return started.then((loaded) => {
      const exported = loaded[method.exportName];
      if (typeof exported !== "function") {
        const message = "Controller does not export method " + String.fromCharCode(96) + method.exportName + String.fromCharCode(96) + ".";
        throw Object.assign(new Error("HJ003: " + message), {
          name: "HtmlDiagnosticError", diagnostic: Object.freeze({ code: "HJ003", message }),
        });
      }
      return Reflect.apply(exported, undefined, [host, ...args]);
    });
  };
  const synchronize = (): void => {
    const next = options.root();
    if (root !== next) {
      // Connected root-arm replacement transfers the same logical controller lifetime.
      if (!(connected && next?.isConnected === true)) disconnect();
      root = next;
      if (next !== null) {
        lastRoot = next;
        for (const method of options.methods) Object.defineProperty(next, method.name, {
          configurable: true, enumerable: false, value: (...args: unknown[]) => invoke(method.name, ...args),
        });
      }
    }
    if (next?.isConnected !== true) { disconnect(); return; }
    if (connected) return;
    connected = true;
    const current = ++generation;
    started = load().then(async (module) => {
      if (!connected || current !== generation) return module;
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
    const element = options.root();
    untrack(synchronize);
    if (element === null) return;
    return observeConnection(element, () => untrack(() => { membership += 1; synchronize(); }));
  });
  $effect(() => () => untrack(() => {
    disconnect();
    for (const stop of [...effects.keys()]) stop();
  }));
  return { invoke };
}
`;

export function svelteHostArtifact(version: string): GeneratedArtifact {
  return Object.freeze({ path: "svelte/host.svelte.ts", content: `// Generated by HTML Next ${version}. Do not edit.\n${SOURCE}` });
}
