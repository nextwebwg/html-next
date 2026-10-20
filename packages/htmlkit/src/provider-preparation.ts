import type { BindingModule, BindingPreparation } from "@nextwebwg/html-next/bindings";
import type { ComponentHost } from "@nextwebwg/html-next/runtime";
import type { ServerPreparationContext } from "@nextwebwg/html-next/server";
import { componentInputs } from "@nextwebwg/html-next/inputs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { existsSync } from "node:fs";

const packaged = fileURLToPath(import.meta.resolve("@nextwebwg/html-next/bindings"));
const source = packaged.replace(/[/\\]dist[/\\]bindings\.js$/, "/src/bindings.ts");
export const bindingsModule = pathToFileURL(fileURLToPath(import.meta.url).endsWith(".ts") && existsSync(source) ? source : packaged).href;
export const preparationModule = import.meta.url;

export interface ProviderModule { readonly module: string; readonly source: string }
export interface ProviderPreparationData {
  readonly phase: "build" | "request";
  readonly modules: Readonly<Record<string, ProviderModule>>;
  readonly required?: readonly { readonly tag: string; readonly selector: string; readonly names: readonly string[] }[];
}

export async function prepare({ document, host, flush, signal, data: input }: ServerPreparationContext): Promise<() => void> {
  const data = input as ProviderPreparationData;
  const { bindModule } = await import(bindingsModule) as typeof import("@nextwebwg/html-next/bindings");
  const modules = new Map(await Promise.all(Object.entries(data.modules).map(async ([tag, descriptor]) =>
    [tag, { descriptor, binding: bindModule(await import(descriptor.module) as BindingModule<ComponentHost>) }] as const)));
  const known = new WeakSet<object>();
  const owned: { host: ComponentHost; tag: string; scope: BindingPreparation }[] = [];
  const dispose = (): void => { for (const entry of owned.toReversed()) entry.scope.dispose(); };
  try {
    for (;;) {
      let found = false;
      for (const root of document.querySelectorAll("[data-component]")) {
        for (const tag of root.getAttribute("data-component")!.split(/\s+/)) {
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
