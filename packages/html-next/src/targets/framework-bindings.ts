import type { GeneratedArtifact } from "../generate.js";

const COMMON = `import { componentInputs, type InputSnapshot } from "@nextwebwg/html-next/inputs";
import { encodeHydrationValue, decodeHydrationValue, type BindingAdoption, type BindingHost, type BindingPreparation } from "@nextwebwg/html-next/bindings";
export const PREPARATION_CONTEXT = Symbol.for("@nextwebwg/html-next.preparation");
const attribute = "data-html-next-bindings", identity = "data-html-next-preparation";
type Frame = readonly [1, string, ReturnType<typeof encodeHydrationValue>];
interface Module {
  prepare(host: BindingHost, options: { phase: "request"; source: string; signal: AbortSignal }): Promise<BindingPreparation>;
  adopt(host: BindingHost, value: BindingAdoption): void;
}
interface Storage {
  value(name: string, input: unknown, bindings?: any): unknown;
  supplied(name: string): boolean;
  publish(name: string, snapshot: InputSnapshot): boolean;
}
function records(value: unknown): Record<string, Frame> { return value == null || value === "" ? {} : JSON.parse(String(value)); }
export class Preparation {
  readonly entries = new Map<string, { pending?: Promise<void>; frame?: Frame; names?: readonly string[]; signature?: string; source: string }>();
  signature(host: BindingHost, outputs: readonly string[]): string {
    const port = componentInputs(host);
    return JSON.stringify(port.readNames.filter(name => !outputs.includes(name) || port.names.includes(name) && port.supplied(name)).map(name => {
      let value: unknown; try { value = encodeHydrationValue(port.read(name)); } catch { value = null; }
      return [name, value, port.status(name), port.names.includes(name) && port.supplied(name)];
    }));
  }
  start(id: string, loader: () => Promise<unknown>, host: BindingHost, source: string): void {
    const previous = this.entries.get(id);
    if (previous?.pending || previous?.source === source && previous.names && previous.signature === this.signature(host, previous.names)) return;
    const entry: { pending?: Promise<void>; frame?: Frame; names?: readonly string[]; signature?: string; source: string } = { source }; this.entries.set(id, entry);
    entry.pending = Promise.resolve().then(loader).then(async candidate => {
      const module = candidate as Module, port = componentInputs(host), watchers = new Set<() => void>();
      let queued = false;
      const notify = () => { if (queued) return; queued = true; queueMicrotask(() => { queued = false; for (const run of [...watchers]) run(); }); };
      const input = { ...port, watch(run: () => void) { watchers.add(run); run(); return () => { watchers.delete(run); }; },
        source(name: string) { const value = port.source(name); return { ...value, publish(snapshot: InputSnapshot) { const accepted = value.publish(snapshot); if (accepted) notify(); return accepted; } }; } };
      const preparedHost = Object.create(host) as BindingHost;
      Object.defineProperty(preparedHost, Symbol.for("@nextwebwg/html-next.inputs.v1"), { value: input });
      const controller = new AbortController(); let prepared: BindingPreparation | undefined;
      try {
        prepared = await module.prepare(preparedHost, { phase: "request", source, signal: controller.signal });
        entry.names = prepared.names;
        entry.signature = this.signature(preparedHost, prepared.names);
        const snapshot = prepared.snapshot();
        if (Object.keys(snapshot.reads).length) {
          const inputs = Object.fromEntries(Object.keys(snapshot.reads).filter(name => !port.supplied(name)).map(name => [name, { value: port.read(name), status: port.status(name) }]));
          entry.frame = [1, source, encodeHydrationValue({ snapshot, inputs })];
        }
      } finally { prepared?.dispose(); controller.abort(); watchers.clear(); }
      delete entry.pending;
    });
  }
  async render<T>(render: () => T): Promise<T> {
    for (;;) {
      const result = render();
      const pending = [...this.entries.values()].flatMap(entry => entry.pending ? [entry.pending] : []);
      if (!pending.length) return result;
      await Promise.all(pending);
    }
  }
}
function moduleBinding(loader: () => Promise<unknown>, options: { tag: string; source: string }, id: string, session: Preparation | undefined, mounted: () => boolean) {
  const browser = typeof document !== "undefined";
  const root = browser ? document.querySelector("[" + identity + "~=" + JSON.stringify(id) + "]") : null;
  const transferred = records(root?.getAttribute(attribute))[options.tag];
  const frame = () => browser ? transferred : session?.entries.get(id)?.frame;
  let host: BindingHost, adoption: BindingAdoption | undefined, loading: Promise<Module> | undefined;
  const load = () => loading ??= Promise.resolve().then(loader).then(candidate => { const module = candidate as Module; if (adoption) module.adopt(host, adoption); return module; });
  const applied = new WeakSet<object>();
  return { load,
    restore(storage: Storage, caller: Record<string, unknown>, bindings?: any): void {
      if (applied.has(storage)) return; applied.add(storage);
      for (const [name, value] of Object.entries(caller)) storage.value(name, value, bindings);
      const value = frame(); if (!value) return;
      if (value[0] !== 1 || value[1] !== options.source) throw new TypeError("Prepared module source revision does not match.");
      adoption = decodeHydrationValue(value[2]) as BindingAdoption;
      if (adoption?.snapshot?.source !== options.source || typeof adoption.inputs !== "object" || adoption.inputs === null) throw new TypeError("Malformed prepared module transfer.");
      for (const [name, snapshot] of Object.entries(adoption.inputs)) if (!storage.supplied(name) && !storage.publish(name, snapshot)) throw new TypeError("Prepared module output failed its declared type.");
    },
    attach(target: BindingHost): void {
      host = target;
      if (!browser) {
        if (!session) throw new Error("Prepared component SSR requires renderPrepared().");
        session.start(id, loader, target, options.source);
      }
    },
    attributes(attrs: Record<string, any>): Record<string, any> {
      const all = { ...records(attrs[attribute]) }, names = new Set(String(attrs[identity] ?? "").split(/\\s+/).filter(Boolean));
      names.delete(id); delete all[options.tag];
      if (!mounted()) { names.add(id); const value = frame(); if (value) all[options.tag] = value; }
      return { ...attrs, [attribute]: Object.keys(all).length ? JSON.stringify(all) : undefined, [identity]: names.size ? [...names].join(" ") : undefined };
    },
  };
}
`;

export function reactBindingsArtifact(version: string): GeneratedArtifact {
  return { path: "react/bindings.ts", content: `// Generated by HTML Next ${version}. Do not edit.
import React from "react";
${COMMON}
export const PreparationContext = React.createContext<Preparation | undefined>(undefined);
export function usePreparedModule(loader: () => Promise<unknown>, options: { tag: string; source: string }) {
  const id = React.useId(), session = React.useContext(PreparationContext), [mounted, setMounted] = React.useState(false);
  const latest = React.useRef(false); latest.current = mounted;
  const binding = React.useRef<ReturnType<typeof moduleBinding> | undefined>(undefined);
  binding.current ??= moduleBinding(loader, options, id, session, () => latest.current);
  React.useLayoutEffect(() => { setMounted(true); }, []);
  return binding.current;
}
export async function renderPrepared(element: React.ReactNode): Promise<string> {
  const { renderToString } = await import("react-dom/server");
  const session = new Preparation();
  return session.render(() => renderToString(React.createElement(PreparationContext.Provider, { value: session }, element)));
}
` };
}

export function svelteBindingsArtifact(version: string): GeneratedArtifact {
  return { path: "svelte/bindings.svelte.ts", content: `// Generated by HTML Next ${version}. Do not edit.
import { getContext, onMount } from "svelte";
${COMMON}
export function usePreparedModule(loader: () => Promise<unknown>, options: { tag: string; source: string }, id: string) {
  let mounted = $state(false);
  onMount(() => { mounted = true; });
  return moduleBinding(loader, options, id, getContext<Preparation>(PREPARATION_CONTEXT), () => mounted);
}
export async function renderPrepared(component: any, options: { props?: Record<string, any>; context?: Map<any, any> } = {}): Promise<string> {
  const { render } = await import("svelte/server"); const session = new Preparation();
  const context = new Map(options.context); context.set(PREPARATION_CONTEXT, session);
  return session.render(() => render(component, { ...options, context }).body);
}
` };
}
