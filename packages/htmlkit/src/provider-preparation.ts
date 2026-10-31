import type { BindingPreparation } from "@nextwebwg/html-next/bindings";
import type { ComponentHost } from "@nextwebwg/html-next/runtime";
import type { ServerPreparationContext } from "@nextwebwg/html-next/server";
import { fileURLToPath, pathToFileURL } from "node:url";
import { existsSync } from "node:fs";
import { componentModule, type ComponentBindingModule } from "./component-module.js";
import { readChannel } from "./read-channel.js";

const packaged = fileURLToPath(import.meta.resolve("@nextwebwg/html-next/bindings"));
const source = packaged.replace(/[/\\]dist[/\\]bindings\.js$/, "/src/bindings.ts");
export const bindingsModule = pathToFileURL(fileURLToPath(import.meta.url).endsWith(".ts") && existsSync(source) ? source : packaged).href;
const packagedInputs = fileURLToPath(import.meta.resolve("@nextwebwg/html-next/inputs"));
const sourceInputs = packagedInputs.replace(/[/\\]dist[/\\]component-inputs\.js$/, "/src/component-inputs.ts");
const inputsModule = pathToFileURL(fileURLToPath(import.meta.url).endsWith(".ts") && existsSync(sourceInputs) ? sourceInputs : packagedInputs).href;
export const preparationModule = import.meta.url;

export interface ProviderModule { readonly module: string; readonly source: string; readonly bound?: true; readonly client?: boolean; readonly readers?: readonly string[] }
export interface ProviderPreparationData {
  readonly phase: "build" | "request";
  readonly modules: Readonly<Record<string, ProviderModule>>;
  readonly required?: readonly { readonly tag: string; readonly selector: string; readonly names: readonly string[] }[];
}

export async function prepare({ document, host, flush, signal, port, data: input }: ServerPreparationContext): Promise<() => void> {
  const data = input as ProviderPreparationData;
  const library = await import(bindingsModule) as typeof import("@nextwebwg/html-next/bindings");
  const { componentInputs } = await import(inputsModule) as typeof import("@nextwebwg/html-next/inputs");
  const remote = port === undefined ? undefined : readChannel(port, library);
  const modules = new Map(await Promise.all(Object.entries(data.modules).map(async ([tag, descriptor]) => {
    const module = await import(descriptor.module);
    if (descriptor.bound) {
      for (const name of ["connect", "prepare", "adopt"]) if (typeof module[name] !== "function") throw new TypeError(`Prepared component ${tag} must export ${name}.`);
      return [tag, { descriptor, binding: module as ReturnType<typeof library.bindModule<ComponentHost>> }] as const;
    }
    const props = Object.fromEntries((descriptor.readers ?? []).map(name => [name, { load: (input: unknown, operation: import("@nextwebwg/html-next/bindings").BindingOperation) => {
      if (remote === undefined) throw new TypeError("Private reader channel was not supplied.");
      return remote.read(tag, name, input, operation);
    } }]));
    return [tag, { descriptor, binding: library.bindModule(componentModule(module as ComponentBindingModule<ComponentHost>, { props }, descriptor.client)) }] as const;
  })));
  const known = new WeakSet<object>();
  const owned: { host: ComponentHost; tag: string; scope: BindingPreparation }[] = [];
  const dispose = (): void => { try { for (const entry of owned.toReversed()) entry.scope.dispose(); } finally { remote?.close(); } };
  try {
    for (;;) {
      let found = false;
      for (const root of document.querySelectorAll(':is([component]:not(template), [data-component]:not([component]))')) {
        for (const tag of (root.getAttribute("component") ?? root.getAttribute("data-component") ?? "").split(/\s+/)) {
          const module = modules.get(tag);
          if (module === undefined) continue;
          const instance = host(root, tag);
          if (instance === undefined || known.has(instance.props)) continue;
          known.add(instance.props);
          const scope = await module.binding.prepare(instance, { phase: data.phase, signal, source: module.descriptor.source });
          owned.push({ host: instance, tag, scope });
          found = true;
        }
      }
      await flush();
      if (!found) break;
    }
    for (const input of data.required ?? []) {
      const root = document.querySelector(input.selector);
      const instance = root === null ? undefined : host(root, input.tag);
      const prepared = owned.find(entry => entry.host.props === instance?.props);
      for (const name of input.names) if (!prepared?.scope.names.includes(name) && (instance === undefined || !componentInputs(instance).supplied(name))) {
        throw new TypeError(`A required prop \`${name}\` of <${input.tag}> has no caller value or provider.`);
      }
    }
    for (const entry of owned) {
      const root = entry.host.root;
      if (!root.isConnected) continue;
      const snapshot = entry.scope.snapshot();
      if (Object.keys(snapshot.reads).length === 0) continue;
      const records = JSON.parse(root.getAttribute("data-htmlkit-bindings") ?? "{}") as Record<string, unknown>;
      records[entry.tag] = snapshot;
      root.setAttribute("data-htmlkit-bindings", JSON.stringify(records));
    }
    return dispose;
  } catch (error) { dispose(); throw error; }
}
