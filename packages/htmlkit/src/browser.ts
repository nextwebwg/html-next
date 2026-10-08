import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { generateComponent, type ComponentDefinition, type TemplateNode } from "@nextwebwg/html-next";
import { normalizePath, type Plugin } from "vite";
import type { BrowserDefinition } from "./types.js";

const packagedRuntime = fileURLToPath(import.meta.resolve("@nextwebwg/html-next/generated-runtime"));
const sourceRuntime = packagedRuntime.replace(/[/\\]dist[/\\]generated-runtime\.js$/, "/src/generated-runtime.ts");
// Workspace source execution can test the same entry before packages have been built.
const runtime = import.meta.url.endsWith(".ts") && existsSync(sourceRuntime) ? sourceRuntime : packagedRuntime;

function stylesheetId(component: BrowserDefinition): string {
  return normalizePath(fileURLToPath(component.definition.source.file)) + ".htmlkit.css";
}

export function stylesheetSources(components: readonly BrowserDefinition[]): ReadonlyMap<string, string> {
  const sources = new Map<string, string>();
  for (const component of components) {
    if (component.styles.css === "") continue;
    const id = stylesheetId(component);
    sources.set(id, (sources.get(id) ?? "") + component.styles.css);
  }
  return sources;
}

/** A component's compiled module: the same id on every page, so pages share its chunk. */
function componentId(definition: ComponentDefinition): string {
  const source = createHash("sha256").update(`${definition.source.file}\0${definition.contract.tag}`).digest("hex").slice(0, 12);
  return `virtual:htmlkit/component/${definition.contract.tag}-${source}.js`;
}

/** A component without behavior: nothing in it reads, writes or listens, so its server DOM is final. */
function inert({ definition, controller }: BrowserDefinition): boolean {
  // A root that is another component's invocation shares that component's root, which adopts it.
  if (controller !== undefined || (definition.declarations?.length ?? 0) > 0 || Object.keys(definition.contract.props).length > 0 ||
    definition.template.name.includes("-")) return false;
  const still = (node: TemplateNode): boolean => node.kind === "text" ? node.expressionPlan === undefined && node.segments === undefined
    : node.kind === "slot" ? node.nameExpression === undefined && node.flow === undefined && (node.props?.length ?? 0) === 0 && (node.fallback ?? []).every(still)
    : node.flow === undefined && (node.events?.length ?? 0) === 0 && node.ref === undefined &&
      node.attributes.every((attribute) => attribute.kind === "literal") && node.children.every(still);
  return still(definition.template);
}

/**
 * Each component compiled to direct DOM code that adopts its server-rendered root, and the page's
 * entry, `entry`, which adopts each server root a parent did not, in document order. A page ships
 * only the generated-runtime helpers its components use; its controllers, stylesheets and declared
 * reads are imported by the components that own them.
 */
export function browserSources(components: readonly BrowserDefinition[], base: string, entry: string): ReadonlyMap<string, string> {
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
      ...component.controller === undefined ? {} : { controller: component.controller } };
    let module = generateComponent(definition, { invocations, hydrate: true })
      .find((artifact) => artifact.path === `vanilla/${definition.contract.name}.js`)!.content
      .replace('"@nextwebwg/html-next/generated-runtime"', JSON.stringify(runtime))
      // Each source file's component styles are one stylesheet module, which its components import.
      .replace(`import "../styles/${definition.contract.tag}.css";`, component.styles.css === "" ? "" : `import ${JSON.stringify(stylesheetId(component))};`)
      .replaceAll(/"\\u0000htmlkit-read-(\d+)([^"]*)"/g, (_, index: string, suffix: string) => `read${index} + ${JSON.stringify(suffix)}`);
    if (reads.length > 0) module = `${reads.join("\n")}\n${module}`;
    sources.set(componentId(definition), module);
  }
  // A component without behavior keeps its server DOM: the page imports it only through a component that invokes it.
  const factories = components.filter((component) => !inert(component))
    .map(({ definition }, index) => [definition.contract.tag, `create${definition.contract.name} as c${index}`, componentId(definition)] as const);
  // The page's stylesheets, a component without behavior's among them, are the entry's.
  sources.set(entry, `${[...stylesheetSources(components).keys()].map((id) => `import ${JSON.stringify(id)};`).join("\n")}
${factories.map(([, name, id]) => `import { ${name} } from ${JSON.stringify(id)};`).join("\n")}
const factories = { ${factories.map(([tag], index) => `${JSON.stringify(tag)}: c${index}`).join(", ")} };
// Outer roots first: each adopts the components its template invokes; a root projected into another is adopted here.
for (const root of document.querySelectorAll("[data-html-next-instance]")) {
  if (!root.hasAttribute("data-html-next-instance")) continue;
  const adopt = factories[root.getAttribute("data-component").split(" ")[0]];
  if (adopt === undefined) root.removeAttribute("data-html-next-instance");
  else adopt({}, undefined, root);
}
document.dispatchEvent(new Event("htmlkit:ready"));
`);
  return sources;
}

export function browserPlugin(sources: ReadonlyMap<string, string>, inputs?: Set<string>): Plugin {
  return {
    name: "htmlkit-browser",
    resolveId(id) { if (sources.has(id)) return id.endsWith(".css") ? id : `\0${id}`; },
    load(id) { return sources.get(id.startsWith("\0") ? id.slice(1) : id); },
    generateBundle() {
      if (inputs !== undefined) for (const id of this.getModuleIds()) if (!id.startsWith("\0")) inputs.add(id);
    },
  };
}
