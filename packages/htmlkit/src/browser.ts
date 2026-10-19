import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { normalizePath, type Plugin } from "vite";
import type { ClientOptions } from "./client.js";
import type { BrowserDefinition } from "./types.js";
import { collectSharedStylesheets, compileComponentGraphStylesForBuild, generateComponent, type ComponentDefinition } from "@nextwebwg/html-next";

const packagedRuntime = fileURLToPath(import.meta.resolve("@nextwebwg/html-next/generated-runtime"));
const sourceRuntime = packagedRuntime.replace(/[/\\]dist[/\\]generated-runtime\.js$/, "/src/generated-runtime.ts");
// Workspace source execution can test the same entry before packages have been built.
const runtime = import.meta.url.endsWith(".ts") && existsSync(sourceRuntime) ? sourceRuntime : packagedRuntime;
const client = fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "./client.ts" : "./client.js", import.meta.url));

export function stylesheetSources(components: readonly BrowserDefinition[]): ReadonlyMap<string, string> {
  const sources = new Map<string, string>();
  const shared = collectSharedStylesheets(components.map(component => component.definition));
  if (shared.length > 0) {
    // One stylesheet holds the page's whole graph, so it is named for the graph: pages that share a
    // first component (their layout) would otherwise overwrite each other's styles.
    const files = components.map(component => component.definition.source.file);
    const graph = createHash("sha256").update(files.join("\0")).digest("hex").slice(0, 16);
    sources.set(`${normalizePath(fileURLToPath(files[0]!))}.${graph}.htmlkit-shared.css`,
      compileComponentGraphStylesForBuild(components.map(component => component.definition)));
    return sources;
  }
  for (const component of components) {
    if (component.styles.css === "") continue;
    const id = normalizePath(fileURLToPath(component.definition.source.file)) + ".htmlkit.css";
    sources.set(id, (sources.get(id) ?? "") + component.styles.css);
  }
  return sources;
}

/** A component's compiled module: the same id on every page, so pages share its chunk. */
function componentId(definition: ComponentDefinition): string {
  const source = createHash("sha256").update(`${definition.source.file}\0${definition.contract.tag}`).digest("hex").slice(0, 12);
  return `virtual:htmlkit/component/${definition.contract.tag}-${source}.js`;
}

/**
 * A page's browser modules: each component compiled to direct DOM code that also adopts its
 * server-rendered root, and the page's entry, `entry`, which registers them with client.ts. A page
 * ships only the generated-runtime helpers its components use; controllers and declared reads are
 * imported by the components that own them, and the page's stylesheets by its entry.
 */
export function browserSources(components: readonly BrowserDefinition[], options: ClientOptions, entry: string, css: readonly string[] = []): ReadonlyMap<string, string> {
  const { base } = options;
  const sources = new Map<string, string>();
  const invocations = new Map(components.map(({ definition }) => [definition.contract.tag, { module: componentId(definition), definition }]));
  for (const component of components) {
    const reads: string[] = [];
    // Declared reads resolve as the page's URLs: a root-relative source under the deployment base, a
    // relative one as the asset Vite emits for it.
    const declarations = component.definition.declarations?.map((declaration) => {
      if (declaration.kind !== "data" || declaration.source === undefined) return declaration;
      const source = declaration.source;
      if (source.startsWith("/") && !source.startsWith("//")) {
        return { ...declaration, source: source.startsWith(base) ? source : base + source.slice(1) };
      }
      if (/^(?:[A-Za-z][A-Za-z\d+.-]*:|\/\/)/.test(source)) return declaration;
      const url = new URL(source, component.definition.source.file);
      reads.push(`import read${reads.length} from ${JSON.stringify(fileURLToPath(url) + "?url&no-inline")};`);
      return { ...declaration, source: `\u0000htmlkit-read-${reads.length - 1}${url.search}${url.hash}` };
    });
    const definition = { ...component.definition, ...declarations === undefined ? {} : { declarations },
      ...component.controller === undefined ? {} : { controller: component.controller },
      ...component.module === undefined ? {} : { module: component.module } };
    let module = generateComponent(definition, { invocations, hydrate: true })
      .find((artifact) => artifact.path === `vanilla/${definition.contract.name}.js`)!.content
      .replace('"@nextwebwg/html-next/generated-runtime"', JSON.stringify(runtime))
      // The page's entry imports its stylesheets: one for the page's graph, or one per source file.
      .replace(`import "../styles/${definition.contract.tag}.css";`, "")
      .replaceAll(/"\\u0000htmlkit-read-(\d+)([^"]*)"/g, (_, index: string, suffix: string) => `read${index} + ${JSON.stringify(suffix)}`);
    if (reads.length > 0) module = `${reads.join("\n")}\n${module}`;
    sources.set(componentId(definition), module);
  }
  // Each component's factory and the invocation attribute each prop is written as (application.ts),
  // which client navigation renders a payload's layers with.
  const registered = components.map(({ definition }, index) => `${JSON.stringify(definition.contract.tag)}: [c${index}, ${JSON.stringify(Object.fromEntries(
    Object.keys(definition.contract.props).map((name) => [name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase(), name])))}]`);
  const functions = "adoptRenderedProps, replaceProjectedNode, generatedHost";
  sources.set(entry, `import { ${functions} } from ${JSON.stringify(runtime)};
import { page } from ${JSON.stringify(client)};
${css.map(file => `import ${JSON.stringify(normalizePath(file))};`).join("\n")}
${[...stylesheetSources(components).keys()].map(id => `import ${JSON.stringify(id)};`).join("\n")}
${components.map(({ definition }, index) => `import { create${definition.contract.name} as c${index} } from ${JSON.stringify(componentId(definition))};`).join("\n")}
page({ ${functions} }, ${JSON.stringify(options)}, { ${registered.join(", ")} });
`);
  return sources;
}

export function browserPlugin(sources: ReadonlyMap<string, string>, inputs?: Set<string>): Plugin {
  return {
    name: "htmlkit-browser",
    // Vite adds ?direct when a document <link> requests a stylesheet; keep the query for its CSS plugin.
    resolveId(id) { const path = id.split("?")[0]!; if (sources.has(path)) return path.endsWith(".css") ? id : `\0${id}`; },
    load(id) { return sources.get((id.startsWith("\0") ? id.slice(1) : id).split("?")[0]!); },
    generateBundle() {
      // Virtual stylesheets keep their ids for Vite's CSS plugin; report only source files.
      if (inputs !== undefined) for (const id of this.getModuleIds()) if (!id.startsWith("\0") && !sources.has(id.split("?")[0]!)) inputs.add(id);
    },
  };
}
