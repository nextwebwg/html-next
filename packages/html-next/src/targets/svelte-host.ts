import type { GeneratedArtifact } from "../generate.js";
import { MODULE_CONNECTION_SOURCE } from "../generated/module-connection-source.js";
import { CONTROLLER_STATE_SOURCE } from "./controller-state-source.js";
import { REQUEST_HOST_SOURCE } from "./request-host-source.js";
import { INPUT_STATUS_SOURCE } from "./shared-generated.js";

const SOURCE = `import { flushSync, untrack } from "svelte";
${INPUT_STATUS_SOURCE}
import { cycleCheckedComputed } from "./reactivity.svelte";
import { componentRoot } from "./render.svelte";

import { observeConnection } from "./connection.svelte";

export interface StateAccess {
  readonly get: () => unknown;
  readonly set: (value: unknown) => void;
}

export interface ComponentHostOptions {
  readonly inputs?: { port(reactions: {
    readonly declarations?: Readonly<Record<string, { readonly read: () => unknown; readonly status: () => InputStatus }>>;
    track(name: string, kind: "value" | "status" | "supplied"): void;
    watch(run: () => void | (() => void)): () => void;
    untracked<T>(run: () => T): T;
  }): unknown };
  readonly availability?: Readonly<Record<string, () => InputStatus>>;
  readonly inputTrack?: (name: string, kind: "value" | "status" | "supplied") => void;
  readonly root: () => Element | null;
  readonly ownsRoot: () => boolean;
  readonly definition: string;
  readonly tag: string;
  readonly controller: string;
  readonly module?: boolean;
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
  /** Asks one of the component's declared requests; its \`has\` builds \`host.hasResponder\`. */
  readonly request?: ((root: Element, connection: AbortSignal, name: string, detail?: unknown, options?: any) => Promise<unknown>)
    & { readonly has?: (host: any, own: string[]) => (name: string) => boolean };
  /** Each declared request's responder, from its function prop or event form, read when the request arrives. */
  readonly responders?: Readonly<Record<string, () => ((event: Event) => void) | undefined>>;
  /** Each named declared script, which a controller reads as \`host.scripts\`. */
  readonly scripts?: Readonly<Record<string, unknown>>;
}

interface ControllerHost {
  readonly [key: symbol]: unknown;
  readonly root: Element;
  readonly element: Element;
  readonly state: Record<string, unknown>;
  readonly data: Readonly<Record<string, unknown>>;
  readonly scripts: Readonly<Record<string, unknown>>;
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
  request?(name: string, detail?: unknown, options?: unknown): Promise<unknown>;
  hasResponder?(name: string): boolean;
  on(type: string, callback: EventListener): () => void;
}

interface ControllerModule {
  readonly connect?: Connect<ControllerHost>;
  readonly default: (host: ControllerHost) => void | (() => void) | Promise<void | (() => void)>;
}

function moduleDiagnostic(code: "HJ001" | "HJ002", options: ComponentHostOptions, reason?: unknown): Error {
  const base = typeof document === "undefined" ? options.definition : new URL(options.definition, document.baseURI).href;
  const url = new URL(options.controller, base).href;
  const tick = String.fromCharCode(96);
  const message = code === "HJ002"
    ? options.module ? "Component module " + tick + url + tick + " export connect must be a function." : "Controller module " + tick + url + tick + " must default-export a function."
    : "Controller module " + tick + url + tick + " failed to load: " + (reason instanceof Error ? reason.message : String(reason)) + ".";
  return Object.assign(new Error(base + ": " + code + ": " + message), {
    name: "HtmlDiagnosticError", diagnostic: Object.freeze({ code, message, source: base }),
  });
}

function documentOrder(elements: readonly Element[]): Element[] {
  return [...elements].filter((element) => element.isConnected)
    .sort((left, right) => left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_PRECEDING ? 1 : -1);
}

${MODULE_CONNECTION_SOURCE}
${CONTROLLER_STATE_SOURCE}
${REQUEST_HOST_SOURCE}

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
  const requests = requestConnection();
  let releaseController: (() => void) | undefined;
  const effects = new Map<() => void, () => void>();
  // A subscription's known responder (k), and for a request's function prop or event form whether one is set (r).
  const subscriptions = new Set<{ type: string; callback: EventListener; cleanup?: () => void; k?: (() => void) | undefined; r?: () => boolean }>();
  type Subscription = typeof subscriptions extends Set<infer S> ? S : never;
  // How many known responders the controller's host.on keeps on its own root, by name.
  const own: string[] = [];
  const known = (subscription: Subscription, target: Element | null): void => {
    subscription.k?.();
    subscription.k = target === null || subscription.r?.() === false ? undefined
      : knownResponder(target, subscription.type, subscription.r ? undefined : own);
  };
  const connect = (subscription: { callback: EventListener; cleanup?: () => void }): void => {
    const result = (subscription.callback as (event: Event) => unknown)(new Event("connect"));
    if (typeof result === "function") subscription.cleanup = result as () => void;
  };
  const report = (error: unknown): void => { queueMicrotask(() => { throw error; }); };
  const propHandles = Object.create(null) as Record<string, ControllerHost["props"][string]>;
  for (const name of options.propNames ?? []) {
    const validity = (): unknown => options.propValidity?.(name);
    // One derived value per prop: a reader of this prop does not run again when another prop changes.
    const value = $derived(options.props()[name]);
    propHandles[name] = Object.freeze({
      get value() { return value; },
      get inputValue() { return options.propInputs?.(name); },
      get validity() { return validity(); },
      validate: validity,
    });
  }
  const host: ControllerHost = {
    get [Symbol.for("@nextwebwg/html-next.inputs.v1")]() {
      return options.inputs?.port({ track: (name, kind) => options.inputTrack!(name, kind),
        declarations: Object.fromEntries([...Object.keys(options.state), ...Object.keys(options.computed)].map(name => [name, {
          read: () => host.state[name], status: () => options.availability?.[name]?.() ?? READY_INPUT,
        }])),
        watch: run => host.effect(run), untracked: run => untrack(run) });
    },
    get root() { return (root ?? lastRoot)!; },
    get element() { return host.root; },
    ...controllerNamespaces(options, options.definition),
    scripts: options.scripts ?? Object.freeze({}),
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
          .filter((element) => componentRoot(element.parentElement) === current &&
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
    // A component that declares requests also has host.request.
    ...(options.request === undefined ? {} : {
      request: (name: string, detail?: unknown, requestOptions?: unknown) =>
        options.request!(host.root, requests.signal(connected), name, detail, requestOptions),
    }),
    on(type, callback) { return listen(type, callback); },
  };
  function listen(type: string, callback: EventListener, set?: () => boolean): () => void {
    const listener: EventListener = type === "connect" || type === "disconnect" || options.request === undefined ? callback : hostListener(type, callback);
    const subscription: Subscription = { type, callback: listener };
    if (set !== undefined) subscription.r = set;
    subscriptions.add(subscription);
    if (type === "connect") { if (connected) connect(subscription); }
    else if (type !== "disconnect" && connected) {
      host.root.addEventListener(type, listener);
      known(subscription, host.root);
      // A responder registered after a request went unanswered tells the asker to ask again.
      relayResponders(host.root, type);
    }
    return () => {
      if (!subscriptions.delete(subscription)) return;
      if (type !== "connect" && type !== "disconnect") host.root.removeEventListener(type, listener);
      known(subscription, null);
      subscription.cleanup?.();
      subscription.cleanup = undefined;
    };
  }
  if (options.request?.has !== undefined) host.hasResponder = options.request.has(host, own);
  Object.freeze(host);
  // Each request's responder listens on the root from its first connection, before the controller runs.
  const responders = Object.entries(options.responders ?? {});
  for (const [name, read] of responders) listen(name, (event) => read()?.(event), () => untrack(read) !== undefined);
  // A function prop or event form set later is a known responder, and relays for its request, as a late host.on does.
  if (responders.length > 0) {
    let responding = untrack(() => responders.map(([, read]) => read() !== undefined));
    $effect(() => {
      const now = responders.map(([, read]) => read() !== undefined);
      untrack(() => {
        const element = root;
        if (element !== null && connected) {
          for (const subscription of subscriptions) if (subscription.r !== undefined) known(subscription, element);
          now.forEach((set, index) => { if (set && !responding[index]) relayResponders(element, responders[index]![0]); });
        }
        responding = now;
      });
    });
  }
  const load = (): Promise<ControllerModule> => controllerModule ??= Promise.resolve().then(loader).then((candidate) => {
    const loaded = candidate as { default?: unknown; connect?: unknown } | null;
    if (options.module ? loaded === null || typeof loaded !== "object" || loaded.connect !== undefined && typeof loaded.connect !== "function" : typeof loaded?.default !== "function") throw moduleDiagnostic("HJ002", options);
    return candidate as ControllerModule;
  }).catch((error: unknown) => {
    if (error instanceof Error && "diagnostic" in error) throw error;
    throw moduleDiagnostic("HJ001", options, error);
  });
  const disconnect = (): void => {
    if (!connected) return;
    connected = false;
    generation += 1;
    requests.end();
    releaseController?.();
    for (const subscription of [...subscriptions]) {
      if (subscription.type === "disconnect") subscription.callback(new Event("disconnect"));
    }
    for (const subscription of [...subscriptions]) {
      if (subscription.type !== "connect" && subscription.type !== "disconnect") host.root.removeEventListener(subscription.type, subscription.callback);
      known(subscription, null);
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
          known(subscription, next);
        }
      }
      root = next;
      if (next !== null) lastRoot = next;
    }
    if (next?.isConnected !== true) { disconnect(); return; }
    if (connected) return;
    connected = true;
    const current = ++generation;
    // Before the controller first runs, the only subscriptions are the requests' responders.
    for (const subscription of [...subscriptions]) {
      if (subscription.type === "connect") connect(subscription);
      else if (subscription.type !== "disconnect") {
        next.addEventListener(subscription.type, subscription.callback);
        known(subscription, next);
        relayResponders(next, subscription.type);
      }
    }
    if (initialized && !options.module) return;
    // Requests from inside this root wait until the controller has run, or failed to load.
    const release = releaseController = holdController(next);
    started = load().then(async (module) => {
      if (!connected || current !== generation) return module;
      initialized = true;
      if (options.module) {
        try { cleanup = activateModule(module, host, report); } finally { release(); }
        return module;
      }
      let invoked: ReturnType<ControllerModule["default"]>;
      try { invoked = module.default(host); } finally { release(); }
      const result = await invoked;
      if (typeof result === "function") {
        if (!connected || current !== generation) result();
        else cleanup = result;
      }
      return module;
    });
    void started.catch(report).finally(release);
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
