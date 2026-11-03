import type { BindingAdoption, BindingHost, BindingPreparation, BindingScopeOptions } from "./bindings.js";
import { componentInputs } from "./inputs.js";
import { decodeHydrationValue, encodeHydrationValue } from "./hydration-value.js";

interface NativeBindingHost extends BindingHost { readonly element: Element }
interface PreparedModule {
  prepare(host: BindingHost, options: Omit<BindingScopeOptions, "phase"> & { readonly phase: "request" }): Promise<BindingPreparation>;
  adopt(host: BindingHost, adoption: BindingAdoption): void;
}
export interface NativePreparedModule {
  readonly tag: string;
  readonly source: string;
  readonly module: PreparedModule;
}
export interface NativePreparationContext {
  readonly document: Document;
  readonly host: (element: Element, tag: string) => NativeBindingHost | undefined;
  readonly signal: AbortSignal;
  readonly flush: () => Promise<void>;
}

const attribute = "data-html-next-bindings";
function records(element: Element): Record<string, unknown> {
  const value = JSON.parse(element.getAttribute(attribute) ?? "{}");
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Malformed prepared module transfer.");
  return value;
}
function write(element: Element, values: Record<string, unknown>): void {
  if (Object.keys(values).length) element.setAttribute(attribute, JSON.stringify(values));
  else element.removeAttribute(attribute);
}
function signature(host: BindingHost, outputs: readonly string[]): string {
  const inputs = componentInputs(host);
  return JSON.stringify(inputs.readNames.filter(name => !outputs.includes(name) || inputs.names.includes(name) && inputs.supplied(name)).map(name => {
    let value: unknown;
    try { value = encodeHydrationValue(inputs.read(name)); } catch { value = "transient"; }
    return [name, value, inputs.status(name)];
  }));
}

/** Prepare native component producers through the server's existing host and rendering lifecycle. */
export async function prepareNativeModules(context: NativePreparationContext, modules: readonly NativePreparedModule[]): Promise<() => void> {
  const prepared = new WeakMap<Element, Map<string, { preparation: BindingPreparation; signature: string }>>();
  const active = new Set<BindingPreparation>();
  const dispose = () => { for (const preparation of [...active].toReversed()) preparation.dispose(); active.clear(); };
  try {
    let progress: boolean;
    do {
      if (context.signal.aborted) throw context.signal.reason;
      progress = false;
      for (const { tag, source, module } of modules) {
        for (const element of context.document.querySelectorAll(`[component~="${tag}"], [data-component~="${tag}"]`)) {
          const host = context.host(element, tag);
          if (!host) continue;
          let entries = prepared.get(element);
          if (!entries) prepared.set(element, entries = new Map());
          let entry = entries.get(tag);
          if (entry && entry.signature === signature(host, entry.preparation.names)) continue;
          if (entry?.preparation.settled) await entry.preparation.settled();
          else {
            if (entry) { entry.preparation.dispose(); active.delete(entry.preparation); }
            const preparation = await module.prepare(host, { phase: "request", signal: context.signal, source });
            active.add(preparation);
            entries.set(tag, entry = { preparation, signature: "" });
          }
          const preparation = entry!.preparation;
          entry!.signature = signature(host, preparation.names);
          const snapshot = preparation.snapshot();
          const all = records(element);
          if (Object.keys(snapshot.reads).length) {
            const inputs = componentInputs(host);
            const values = Object.fromEntries(Object.keys(snapshot.reads).filter(name => !inputs.supplied(name)).map(name =>
              [name, { value: inputs.read(name), status: inputs.status(name) }]));
            all[tag] = [1, source, encodeHydrationValue({ snapshot, inputs: values })];
          } else delete all[tag];
          write(element, all);
          progress = true;
          await context.flush();
        }
      }
    } while (progress);
    return dispose;
  } catch (error) { dispose(); throw error; }
}

/** Adopt producer read identities before the native root's held connection is released. */
export function adoptNativeModule(host: NativeBindingHost, module: PreparedModule, options: { readonly tag: string; readonly source: string }): void {
  const all = records(host.element), frame = all[options.tag];
  if (frame === undefined) return;
  if (!Array.isArray(frame) || frame[0] !== 1 || frame[1] !== options.source) throw new TypeError("Prepared module source revision does not match.");
  const adoption = decodeHydrationValue(frame[2]) as BindingAdoption;
  if (adoption === null || typeof adoption !== "object" || adoption.snapshot?.source !== options.source || adoption.inputs === null || typeof adoption.inputs !== "object") {
    throw new TypeError("Malformed prepared module transfer.");
  }
  const inputs = componentInputs(host);
  for (const [name, snapshot] of Object.entries(adoption.inputs)) {
    if (inputs.supplied(name)) continue;
    const source = inputs.source(name);
    try { if (!source.publish(snapshot)) throw new TypeError("Prepared module output failed its declared type."); }
    finally { source.dispose(); }
  }
  module.adopt(host, adoption);
  delete all[options.tag];
  write(host.element, all);
}
