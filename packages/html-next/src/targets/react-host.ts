import type { GeneratedArtifact } from "../generate.js";
import { NATIVE_CONNECTION_SOURCE } from "./native-connection-source.js";

const SOURCE = `import React from "react";

interface Dependency { readonly subscribers: Set<Reaction>; }
interface Reaction {
  readonly dependencies: Set<Dependency>;
  stopped: boolean;
  invalidate(): void;
}

let activeReaction: Reaction | undefined;

function track(dependency: Dependency): void {
  if (activeReaction === undefined || activeReaction.stopped) return;
  dependency.subscribers.add(activeReaction);
  activeReaction.dependencies.add(dependency);
}

function clear(reaction: Reaction): void {
  for (const dependency of reaction.dependencies) dependency.subscribers.delete(reaction);
  reaction.dependencies.clear();
}

function notify(dependency: Dependency): void {
  for (const reaction of [...dependency.subscribers]) reaction.invalidate();
}

function cycleError(): Error {
  const message = "A reactive computed value depends on itself.";
  return Object.assign(new Error("HR006: " + message), {
    name: "HtmlDiagnosticError", diagnostic: Object.freeze({ code: "HR006", message }),
  });
}

${NATIVE_CONNECTION_SOURCE}
export interface StateAccess {
  readonly get: () => unknown;
  readonly set: (value: unknown) => void;
}

export interface ComponentHostOptions {
  readonly root: React.RefObject<Element | null>;
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

/** React owns the DOM; the controller owns only its connection lifetime and local reactions. */
export function useComponentHost(loader: () => Promise<unknown>, options: ComponentHostOptions): void {
  const latest = React.useRef(options);
  latest.current = options;
  const runtime = React.useRef<{
    readonly host: ControllerHost;
    readonly synchronize: () => void;
    readonly disconnect: () => void;
    readonly checkValues: () => void;
  } | null>(null);

  if (runtime.current === null) {
    let controllerModule: Promise<ControllerModule> | undefined;
    let started: Promise<ControllerModule> | undefined;
    let cleanup: void | (() => void);
    let connected = false;
    let root: Element | null = null;
    let lastRoot: Element | null = null;
    let generation = 0;
    const effects = new Set<() => void>();
    const dependencies = new Map<string, Dependency>();
    const previousValues = new Map<string, unknown>();
    const dependency = (name: string): Dependency => {
      let result = dependencies.get(name);
      if (result === undefined) { result = { subscribers: new Set() }; dependencies.set(name, result); }
      return result;
    };
    const report = (error: unknown): void => { queueMicrotask(() => { throw error; }); };
    const propHandles = Object.create(null) as Record<string, ControllerHost["props"][string]>;
    for (const name of options.propNames ?? []) {
      const validity = (): unknown => latest.current.propValidity?.(name);
      propHandles[name] = Object.freeze({
        get value() { track(dependency("prop:value:" + name)); return latest.current.props()[name]; },
        get inputValue() { track(dependency("prop:input:" + name)); return latest.current.propInputs?.(name); },
        get validity() { track(dependency("prop:validity:" + name)); return validity(); },
        validate: validity,
      });
    }
    const host: ControllerHost = {
      get root() {
        track(dependency("root"));
        return (latest.current.root.current ?? root ?? lastRoot)!;
      },
      state: new Proxy({} as Record<string, unknown>, {
        get: (_target, name) => {
          if (typeof name !== "string") return undefined;
          track(dependency("state:" + name));
          const current = latest.current;
          if (Object.hasOwn(current.state, name)) return current.state[name]!.get();
          if (Object.hasOwn(current.computed, name)) return current.computed[name]!();
          return undefined;
        },
        set: (_target, name, value) => {
          const current = latest.current;
          if (typeof name !== "string" || !Object.hasOwn(current.state, name)) {
            const tick = String.fromCharCode(96);
            throw new TypeError("Only declared state roots are writable; " + tick + String(name) + tick + " is read-only.");
          }
          const entry = current.state[name]!;
          const previous = entry.get();
          entry.set(value);
          if (!Object.is(previous, value)) notify(dependency("state:" + name));
          return true;
        },
        has: (_target, name) => {
          const current = latest.current;
          return typeof name === "string" && (Object.hasOwn(current.state, name) ||
            Object.hasOwn(current.computed, name));
        },
      }),
      props: Object.freeze(propHandles),
      refs: new Proxy({} as Record<string, Element | readonly Element[]>, {
        get: (_target, name) => {
          if (typeof name !== "string") return undefined;
          const elements = latest.current.refs.get(name);
          if (elements === undefined) return undefined;
          const ordered = documentOrder(elements);
          return ordered.length === 1 ? ordered[0] : ordered;
        },
        has: (_target, name) => typeof name === "string" && latest.current.refs.has(name),
      }),
      slots: new Proxy({} as Record<string, readonly Element[]>, {
        get: (_target, name) => {
          if (typeof name !== "string") return undefined;
          const currentRoot = latest.current.root.current;
          if (currentRoot === null) return [];
          return Array.from(currentRoot.querySelectorAll("[data-slotted]"))
            .filter((element) => element.parentElement?.closest("[data-component]") === currentRoot &&
              (element.getAttribute("slot") ?? "default") === name);
        },
        has: (_target, name) => typeof name === "string" && host.slots[name]!.length > 0,
      }),
      signal<T>(initial: T) {
        let value = initial;
        const source: Dependency = { subscribers: new Set() };
        const set = (next: T): void => {
          if (Object.is(value, next)) return;
          value = next;
          notify(source);
        };
        return { get: () => { track(source); return value; }, set, update: (update: (value: T) => T) => set(update(value)) };
      },
      computed<T>(compute: () => T) {
        const source: Dependency = { subscribers: new Set() };
        let dirty = true;
        let reading = false;
        let cached!: T;
        const reaction: Reaction = {
          dependencies: new Set(), stopped: false,
          invalidate() { if (!dirty) { dirty = true; notify(source); } },
        };
        return { get(): T {
          track(source);
          if (reading) throw cycleError();
          if (!dirty) return cached;
          clear(reaction);
          const prior = activeReaction;
          activeReaction = reaction;
          reading = true;
          try { cached = compute(); dirty = false; return cached; }
          finally { reading = false; activeReaction = prior; }
        } };
      },
      effect(run) {
        let cleanupEffect: void | (() => void);
        let queued = false;
        const reaction: Reaction = {
          dependencies: new Set(), stopped: false,
          invalidate() {
            if (queued || reaction.stopped) return;
            queued = true;
            queueMicrotask(() => { queued = false; execute(); });
          },
        };
        const execute = (): void => {
          if (reaction.stopped || !connected) return;
          cleanupEffect?.();
          cleanupEffect = undefined;
          clear(reaction);
          const prior = activeReaction;
          activeReaction = reaction;
          try { cleanupEffect = run(); } finally { activeReaction = prior; }
        };
        const stop = (): void => {
          if (reaction.stopped) return;
          reaction.stopped = true;
          cleanupEffect?.();
          clear(reaction);
          effects.delete(stop);
        };
        effects.add(stop);
        execute();
        return stop;
      },
      dispatch: (name, detail) => latest.current.dispatch(host.root, name, detail),
    };
    const load = (): Promise<ControllerModule> => controllerModule ??= Promise.resolve().then(loader).then((candidate) => {
      if (typeof (candidate as { default?: unknown } | null)?.default !== "function") throw moduleDiagnostic("HJ002", latest.current);
      return candidate as ControllerModule;
    }).catch((error: unknown) => {
      if (error instanceof Error && "diagnostic" in error) throw error;
      throw moduleDiagnostic("HJ001", latest.current, error);
    });
    const disconnect = (): void => {
      if (!connected) return;
      connected = false;
      generation += 1;
      for (const stop of [...effects]) stop();
      cleanup?.();
      cleanup = undefined;
    };
    const installMethods = (element: Element): void => {
      for (const method of latest.current.methods) {
        Object.defineProperty(element, method.name, {
          configurable: true, enumerable: false,
          value: (...args: unknown[]) => {
            if (started === undefined) return Promise.reject(new TypeError(
              "Controller method " + String.fromCharCode(96) + method.name + String.fromCharCode(96) +
              " is not ready for <" + element.getAttribute("data-component") + ">.",
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
          },
        });
      }
    };
    const synchronize = (): void => {
      const next = latest.current.root.current;
      if (root !== next) {
        // A root-arm replacement keeps the logical component connected. Only a genuine
        // interval without a connected root ends its controller lifetime.
        const transferred = connected && next?.isConnected === true;
        if (!transferred) disconnect();
        root = next;
        if (next !== null) { lastRoot = next; installMethods(next); }
        if (transferred) notify(dependency("root"));
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
    const checkValues = (): void => {
      const current = latest.current;
      const values = Object.fromEntries(Object.entries(current.state).map(([name, entry]) => ["state:" + name, entry.get()]));
      for (const name of current.propNames ?? []) {
        values["prop:value:" + name] = current.props()[name];
        values["prop:input:" + name] = current.propInputs?.(name);
        values["prop:validity:" + name] = JSON.stringify(current.propValidity?.(name));
      }
      for (const [name, value] of Object.entries(values)) {
        if (previousValues.has(name) && !Object.is(previousValues.get(name), value)) notify(dependency(name));
        previousValues.set(name, value);
      }
      for (const name of Object.keys(current.computed)) notify(dependency("state:" + name));
    };
    runtime.current = { host, synchronize, disconnect, checkValues };
  }

  React.useLayoutEffect(() => { runtime.current!.checkValues(); runtime.current!.synchronize(); });
  React.useLayoutEffect(() => {
    const root = latest.current.root.current;
    if (root === null) return;
    const stopObserving = observeConnection(root, runtime.current!.synchronize);
    return () => { stopObserving(); runtime.current!.disconnect(); };
  }, []);
}
`;

export function reactHostArtifact(version: string): GeneratedArtifact {
  return Object.freeze({ path: "react/host.ts", content: `// Generated by HTML Next ${version}. Do not edit.\n${SOURCE}` });
}
