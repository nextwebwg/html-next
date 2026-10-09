import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { normalizePath, type Plugin } from "vite";
import type { BrowserDefinition } from "./types.js";

const packagedRuntime = fileURLToPath(import.meta.resolve("@nextwebwg/html-next/runtime"));
const sourceRuntime = packagedRuntime.replace(/[/\\]dist[/\\]runtime\.js$/, "/src/runtime.ts");
// Workspace source execution can test the same entry before packages have been built.
const runtime = import.meta.url.endsWith(".ts") && existsSync(sourceRuntime) ? sourceRuntime : packagedRuntime;

export function stylesheetSources(components: readonly BrowserDefinition[]): ReadonlyMap<string, string> {
  const sources = new Map<string, string>();
  for (const component of components) {
    if (component.styles.css === "") continue;
    const id = normalizePath(fileURLToPath(component.definition.source.file)) + ".htmlkit.css";
    sources.set(id, (sources.get(id) ?? "") + component.styles.css);
  }
  return sources;
}

/** HTML Next owns adoption, observation, reads, controllers, and teardown. */
export function browserSource(components: readonly BrowserDefinition[], base: string, css: readonly string[] = []): string {
  const controlled = components.filter(component => component.controller !== undefined);
  const definitions = components.map(({ definition }) => ({ ...definition, css: definition.css ? "/* external stylesheet */" : "",
    source: { file: `${definition.contract.tag}.html` } }));
  const reads: { definition: number; declaration: number; asset: string; suffix: string }[] = [];
  for (let i = 0; i < definitions.length; i++) {
    const definition = definitions[i]!;
    if (definition.declarations === undefined) continue;
    definition.declarations = definition.declarations.map((declaration, j) => {
      if (declaration.kind !== "data" || declaration.source === undefined) return declaration;
      const source = declaration.source;
      if (source.startsWith("/") && !source.startsWith("//")) {
        return { ...declaration, source: source.startsWith(base) ? source : base + source.slice(1) };
      }
      if (/^(?:[A-Za-z][A-Za-z\d+.-]*:|\/\/)/.test(source)) return declaration;
      const url = new URL(source, components[i]!.definition.source.file);
      const asset = fileURLToPath(url);
      reads.push({ definition: i, declaration: j, asset, suffix: url.search + url.hash });
      return declaration;
    });
  }
  return `import { registerComponentDefinitions, observeDocument, getComponentHost } from ${JSON.stringify(runtime)};
${css.map(file => `import ${JSON.stringify(normalizePath(file))};`).join("\n")}
${[...stylesheetSources(components).keys()].map(id => `import ${JSON.stringify(id)};`).join("\n")}
${reads.map((read, i) => `import read${i} from ${JSON.stringify(read.asset + "?url&no-inline")};`).join("\n")}
${controlled.map((component, index) => `import * as controller${index} from ${JSON.stringify(component.controller)};`).join("\n")}
const controllers = { ${controlled.map((component, index) => `${JSON.stringify(component.definition.contract.tag)}: controller${index}`).join(",")} };
const styleStates = ${JSON.stringify(Object.fromEntries(components.map(component => [component.definition.contract.tag, component.styles.stateNames])))};
const definitions = ${JSON.stringify(definitions)};
${reads.map((read, i) => `definitions[${read.definition}].declarations[${read.declaration}].source = read${i} + ${JSON.stringify(read.suffix)};`).join("\n")}
registerComponentDefinitions(definitions, document, (_css, definition) => ({ css: '', stateNames: styleStates[definition.contract.tag] ?? [] }));
const initialized = new WeakSet();
export const stop = observeDocument(document, { onConnect(element, definition) {
  const controller = controllers[definition.contract.tag];
  if (!controller) return;
  if (typeof controller.default !== 'function') throw new Error('Controller for ' + definition.contract.tag + ' must export a default function');
  const host = getComponentHost(element);
  if (initialized.has(host)) return;
  initialized.add(host);
  return controller.default(host);
} });
document.dispatchEvent(new Event('hk:ready'));
`;
}

export function browserPlugin(sources: ReadonlyMap<string, string>, inputs?: Set<string>): Plugin {
  return {
    name: "htmlkit-browser",
    // Vite adds ?direct when a document <link> requests a stylesheet; keep the query for its CSS plugin.
    resolveId(id) { const path = id.split("?")[0]!; if (sources.has(path)) return path.endsWith(".css") ? id : `\0${id}`; },
    load(id) { return sources.get((id.startsWith("\0") ? id.slice(1) : id).split("?")[0]!); },
    generateBundle() {
      if (inputs !== undefined) for (const id of this.getModuleIds()) if (!id.startsWith("\0")) inputs.add(id);
    },
  };
}
