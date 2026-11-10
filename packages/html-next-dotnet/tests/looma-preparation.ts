import type { BindingHost, BindingPreparation } from "../../html-next/src/bindings.js";
import type { ComponentContract } from "../../html-next/src/types.js";
import type { InputSnapshot } from "../../html-next/src/inputs.js";

export interface PreparationRequest {
  tag: string;
  source: string;
  readNames: string[];
  supplied: string[];
  values: Record<string, { value: string; ready: boolean }>;
}

export interface PreparationService {
  modules: Record<string, { prepare(host: BindingHost, options: { source: string; phase: "request"; signal: AbortSignal }): Promise<BindingPreparation> }>;
  contracts: Record<string, ComponentContract>;
  INPUT_PORT: symbol;
  createInputPort: typeof import("../../html-next/src/inputs.js").createInputPort;
  parseTypedValue: typeof import("../../html-next/src/index.js").parseTypedValue;
  selectedPropType: typeof import("../../html-next/src/index.js").selectedPropType;
  encodeHydrationValue: typeof import("../../html-next/src/hydration-value.js").encodeHydrationValue;
  decodeHydrationValue: typeof import("../../html-next/src/hydration-value.js").decodeHydrationValue;
  signal<T>(value: T): { value: T; peek(): T };
  effect(run: () => void | (() => void)): () => void;
  untracked<T>(run: () => T): T;
  batch<T>(run: () => T): T;
}

/** Run the authored module as an application service. C# supplies reads and accepts the returned output. */
export async function prepareModule(service: PreparationService, request: PreparationRequest,
  read: (names: string[]) => Promise<PreparationRequest["values"]>, signal: AbortSignal) {
  const module = service.modules[request.tag];
  const contract = service.contracts[request.tag];
  if (!module || !contract) throw new Error(`No prepared module for ${request.tag}.`);
  const unresolved = { ready: false, pending: false, stale: false, error: null };
  const values = new Map(request.readNames.map(name => [name, service.signal<InputSnapshot>({ value: undefined, status: unresolved })]));
  const revisions = new Map<string, number>();
  const loaded = new Set<string>();
  const missing = new Set<string>();
  const supply = (inputs: PreparationRequest["values"]) => service.batch(() => {
    for (const [name, input] of Object.entries(inputs)) {
      const destination = values.get(name);
      if (!destination) throw new Error(`Native service returned undeclared binding ${name}.`);
      loaded.add(name);
      destination.value = { value: service.decodeHydrationValue(JSON.parse(input.value)), status: { ...unresolved, ready: input.ready } };
      revisions.set(name, (revisions.get(name) ?? 0) + 1);
    }
  });
  supply(request.values);
  const snapshot = (name: string) => {
    if (!loaded.has(name)) missing.add(name);
    return values.get(name)!.value;
  };
  const port = service.createInputPort({
    names: Object.keys(contract.props), readNames: request.readNames,
    read: name => snapshot(name).value,
    status: name => snapshot(name).status,
    supplied: name => request.supplied.includes(name),
    revision: name => revisions.get(name) ?? 0,
    publish(name, input) {
      const prop = contract.props[name]!;
      let value = input.value;
      if (input.status.ready) {
        if (value === null || value === undefined) value = prop.default ?? null;
        else {
          const selectors = Object.fromEntries([...values].map(([key, entry]) => [key, entry.peek().value]));
          const type = service.selectedPropType(contract, prop, selectors);
          if (type === null) return false;
          const parsed = service.parseTypedValue(value, type, "$", "value");
          if (!parsed.ok) return false;
          value = parsed.value;
        }
      }
      revisions.set(name, (revisions.get(name) ?? 0) + 1);
      values.get(name)!.value = { value, status: input.status };
      return true;
    },
    untracked: service.untracked, watch: service.effect,
  });
  const props = Object.fromEntries(port.names.map(name => [name, { get value() { return port.read(name); } }]));
  const host = { props, [service.INPUT_PORT]: port };
  const preparation = await module.prepare(host, { source: request.source, phase: "request", signal });
  try {
    while (missing.size) {
      const names = [...missing]; missing.clear();
      const inputs = await read(names);
      for (const name of names) if (!Object.hasOwn(inputs, name)) throw new Error(`Native service omitted requested binding ${name}.`);
      supply(inputs);
      await preparation.settled?.();
    }
    const reads: Record<string, { input: string; value: string }> = {};
    for (const [name, identity] of Object.entries(preparation.snapshot().reads)) {
      const input = port.status(name);
      if (identity.error || input.error) throw new Error(`Preparing ${request.tag}.${name}: ${(identity.error ?? input.error)!.message}`);
      if (identity.value !== identity.input || !input.ready || input.pending || input.stale) continue;
      reads[name] = { input: identity.input, value: JSON.stringify(service.encodeHydrationValue(port.read(name))) };
    }
    return { source: request.source, reads };
  } finally { preparation.dispose(); }
}
