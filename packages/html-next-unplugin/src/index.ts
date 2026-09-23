import { relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  generateComponent,
  HtmlDiagnosticError,
  loadNodeComponents,
  type ComponentDefinition,
  type ComponentGraphNode,
  type ElementNode,
  type TemplateNode,
} from "@nextwebwg/html-next";
import { createUnplugin } from "unplugin";

export const componentsModule = "virtual:html-next/components";
export const supportModule = "virtual:html-next/support";
const resolvedComponentsModule = "\0html-next:components";
const resolvedSupportModule = "\0html-next:support";
const publicComponentPrefix = `${componentsModule}/`;
const resolvedPublicComponentPrefix = "\0html-next:public-component:";
const componentPrefix = "html-next:component:";
const resolvedComponentPrefix = `\0${componentPrefix}`;
const stylePrefix = "html-next:style:";
const resolvedStylePrefix = `\0${stylePrefix}`;

export interface HtmlNextPluginOptions {
  readonly entries: readonly string[];
  readonly root?: string;
  readonly manifestFile?: string | false;
  readonly mode?: "application" | "library";
  readonly dynamicBoundaries?: readonly HtmlNextDynamicBoundary[];
}

export interface HtmlNextDynamicBoundary {
  readonly tag: string;
  readonly strategy: "external-custom-element";
}

export interface HtmlNextBuildManifest {
  readonly mode: "native-application-or-library-build";
  readonly delivery: "application" | "library";
  readonly entries: readonly string[];
  readonly publicEntries: readonly {
    readonly name: string;
    readonly tag: string;
    readonly source: string;
    readonly module: string;
  }[];
  readonly components: readonly {
    readonly name: string;
    readonly tag: string;
    readonly source: string;
    readonly dependencies: readonly string[];
    readonly capabilities: readonly string[];
  }[];
  readonly capabilities: readonly string[];
  readonly supportImports: readonly string[];
  readonly support: {
    readonly module: typeof supportModule;
    readonly imports: readonly string[];
    readonly capabilities: readonly string[];
  };
  readonly dynamicBoundaries: readonly {
    readonly tag: string;
    readonly strategy: "external-custom-element";
    readonly usedBy: readonly string[];
  }[];
}

interface CompiledGraph {
  readonly entry: string;
  readonly components: ReadonlyMap<string, string>;
  readonly publicComponents: ReadonlyMap<string, string>;
  readonly styles: ReadonlyMap<string, string>;
  readonly support: string;
  readonly sourceFiles: readonly string[];
  readonly manifest: HtmlNextBuildManifest;
}

export function componentModule(tag: string): string {
  return `${publicComponentPrefix}${encodeURIComponent(tag)}`;
}

function diagnostic(code: string, message: string, source?: string): never {
  throw new HtmlDiagnosticError(source === undefined ? { code, message } : { code, message, source });
}

function escapePattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function visitComponentNodes(node: TemplateNode, visit: (node: ElementNode) => void): void {
  if (node.kind === "text") return;
  if (node.kind === "slot") {
    for (const child of node.fallback ?? []) visitComponentNodes(child, visit);
    return;
  }
  if (node.name.includes("-")) visit(node);
  for (const child of node.children) visitComponentNodes(child, visit);
}

function componentId(url: string): string {
  return `${componentPrefix}${encodeURIComponent(url)}.js`;
}

function resolvedComponentId(url: string): string {
  return `\0${componentId(url)}`;
}

function publicComponentId(tag: string): string {
  return `${resolvedPublicComponentPrefix}${encodeURIComponent(tag)}`;
}

function collectInvocationEdges(
  nodes: ReadonlyMap<string, ComponentGraphNode>,
  tags: ReadonlyMap<string, string>,
  dynamicBoundaries: ReadonlyMap<string, HtmlNextDynamicBoundary>,
): {
  readonly edges: ReadonlyMap<string, ReadonlyMap<string, string>>;
  readonly dynamicUses: ReadonlyMap<string, ReadonlySet<string>>;
} {
  const edges = new Map<string, ReadonlyMap<string, string>>();
  const dynamicUses = new Map<string, Set<string>>();
  for (const node of nodes.values()) {
    const invoked = new Map<string, string>();
    visitComponentNodes(node.definition.template, (invocation) => {
      const tag = invocation.name;
      const boundary = dynamicBoundaries.get(tag);
      if (boundary !== undefined) {
        const uses = dynamicUses.get(tag) ?? new Set<string>();
        uses.add(node.url);
        dynamicUses.set(tag, uses);
        return;
      }
      const target = tags.get(tag);
      if (target === undefined || !node.dependencies.includes(target)) {
        diagnostic(
          "HN001",
          `Component invocation <${tag}> is not a declared static dependency or dynamic boundary.`,
          node.url,
        );
      }
      if (
        invocation.attributes.length > 0 || invocation.children.length > 0 ||
        invocation.flow !== undefined || invocation.ref !== undefined ||
        (invocation.events?.length ?? 0) > 0
      ) {
        diagnostic(
          "HN009",
          `Compiled invocation <${tag}> cannot yet carry attributes, projected children, events, refs, or structural flow.`,
          node.url,
        );
      }
      const targetNode = nodes.get(target)!;
      if (Object.values(targetNode.definition.contract.props).some((prop) => prop.required)) {
        diagnostic(
          "HN014",
          `Compiled invocation <${tag}> requires inputs, but invocation inputs are not implemented yet.`,
          node.url,
        );
      }
      invoked.set(tag, target);
    });
    edges.set(node.url, invoked);
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (url: string): void => {
    if (visited.has(url)) return;
    if (visiting.has(url)) diagnostic("HN002", "Compiled component invocations form a cycle.", url);
    visiting.add(url);
    for (const target of edges.get(url)?.values() ?? []) visit(target);
    visiting.delete(url);
    visited.add(url);
  };
  for (const url of nodes.keys()) visit(url);

  return { edges, dynamicUses };
}

function supportSource(imports: ReadonlySet<string>): string {
  const lines: string[] = [];
  if (imports.has("@nextwebwg/html-next/generated-runtime")) {
    lines.push('export { manageGeneratedProps } from "@nextwebwg/html-next/generated-runtime";');
  }
  if (imports.has("@nextwebwg/html-next/runtime")) {
    lines.push('export { manageComponentLifecycle } from "@nextwebwg/html-next/runtime";');
  }
  return lines.length === 0 ? "export {};\n" : `${lines.join("\n")}\n`;
}

function routeSupportImports(module: string, imports: Set<string>): string {
  let routed = module;
  for (const source of [
    "@nextwebwg/html-next/generated-runtime",
    "@nextwebwg/html-next/runtime",
  ]) {
    if (!routed.includes(source)) continue;
    imports.add(source);
    routed = routed.replaceAll(source, supportModule);
  }
  return routed;
}

function routeComponentInvocations(
  module: string,
  node: ComponentGraphNode,
  invoked: ReadonlyMap<string, string>,
  nodes: ReadonlyMap<string, ComponentGraphNode>,
): string {
  if (invoked.size === 0) return module;
  if (module.includes("manageComponentLifecycle")) {
    diagnostic(
      "HN003",
      "A component using the general runtime cannot yet contain compiled component invocations.",
      node.url,
    );
  }
  const imports: string[] = [];
  let routed = module;
  for (const [tag, url] of invoked) {
    const target = nodes.get(url)!;
    const factory = `create${target.definition.contract.name}`;
    imports.push(`import { ${factory} } from ${JSON.stringify(componentId(url))};`);
    const creation = `document.createElement(${JSON.stringify(tag)})`;
    const variables: string[] = [];
    routed = routed.split("\n").map((line) => {
      const match = line.match(
        new RegExp(`^(\\s*)const ([A-Za-z_$][A-Za-z0-9_$]*) = ${escapePattern(creation)};$`),
      );
      if (match === null) return line;
      variables.push(match[2]!);
      return `${match[1]}const ${match[2]} = ${factory}();`;
    }).join("\n");
    if (variables.length === 0) {
      diagnostic("HN013", `The native generator did not expose compiled invocation <${tag}>.`, node.url);
    }
    for (const variable of variables) {
      // A delegated root carries every owner's token.
      const tag = JSON.stringify(node.definition.contract.tag);
      routed = routed.replace(
        `${variable}.setAttribute("data-component", ${tag});`,
        `${variable}.setAttribute("data-component", [${variable}.getAttribute("data-component"), ${tag}].filter(Boolean).join(" "));`,
      );
    }
  }
  return `${imports.join("\n")}\n${routed}`;
}

function visitTemplate(node: TemplateNode, capabilities: Set<string>): void {
  if (node.kind === "slot") {
    capabilities.add(node.name === undefined ? "default-slot" : "named-slots");
    if (node.nameExpression !== undefined) capabilities.add("dynamic-slots");
    for (const child of node.fallback ?? []) visitTemplate(child, capabilities);
    return;
  }
  if (node.kind === "text") return;
  if (node.flow !== undefined) capabilities.add(node.flow.kind === "each" ? "keyed-lists" : "structural-flow");
  if (node.name.includes("-")) capabilities.add("component-invocations");
  if ((node.events?.length ?? 0) > 0) capabilities.add("event-handlers");
  if (node.ref !== undefined) capabilities.add("refs");
  for (const attribute of node.attributes) {
    if (attribute.kind === "literal") continue;
    capabilities.add(attribute.kind === "directive" ? attribute.name : "bindings");
    if (attribute.kind === "attribute" && attribute.twoWay === true) capabilities.add("two-way-bindings");
  }
  for (const child of node.children) visitTemplate(child, capabilities);
}

function componentCapabilities(definition: ComponentDefinition): readonly string[] {
  const capabilities = new Set<string>(["native-markup"]);
  if (Object.keys(definition.contract.props).length > 0) capabilities.add("props");
  if (definition.css !== "") capabilities.add("scoped-styles");
  if (definition.controller !== undefined) capabilities.add("controllers");
  for (const declaration of definition.declarations ?? []) capabilities.add(declaration.kind);
  visitTemplate(definition.template, capabilities);
  return Object.freeze([...capabilities].sort());
}

function displayPath(root: string, url: string): string {
  const path = fileURLToPath(url);
  return relative(root, path).split(sep).join("/");
}

async function compileGraph(options: HtmlNextPluginOptions): Promise<CompiledGraph> {
  if (options.entries.length === 0) throw new Error("HTML Next requires at least one component entry.");
  const root = resolve(options.root ?? process.cwd());
  const delivery = options.mode ?? "application";
  if (delivery !== "application" && delivery !== "library") {
    diagnostic("HN012", `Unknown native build mode \`${String(delivery)}\`.`);
  }
  const entryURLs = options.entries.map((entry) => pathToFileURL(resolve(root, entry)).href);
  if (new Set(entryURLs).size !== entryURLs.length) {
    diagnostic("HN004", "A component entry may be configured only once.");
  }
  const graph = await loadNodeComponents(entryURLs, { baseURL: pathToFileURL(`${root}${sep}`).href });
  const components = new Map<string, string>();
  const publicComponents = new Map<string, string>();
  const styles = new Map<string, string>();
  const manifestComponents: HtmlNextBuildManifest["components"][number][] = [];
  const allCapabilities = new Set<string>();
  const supportImports = new Set<string>();
  const dynamicBoundaries = new Map<string, HtmlNextDynamicBoundary>();
  const generatedNames = new Map<string, string>();

  for (const node of graph.nodes.values()) {
    const name = node.definition.contract.name;
    const prior = generatedNames.get(name);
    if (prior !== undefined && prior !== node.url) {
      diagnostic("HN010", `Generated factory name \`${name}\` collides with ${prior}.`, node.url);
    }
    generatedNames.set(name, node.url);
  }

  for (const boundary of options.dynamicBoundaries ?? []) {
    if (!boundary.tag.includes("-")) {
      diagnostic("HN005", `Dynamic boundary tag \`${boundary.tag}\` is not a custom-element name.`);
    }
    if (dynamicBoundaries.has(boundary.tag)) {
      diagnostic("HN006", `Dynamic boundary <${boundary.tag}> is configured more than once.`);
    }
    if (graph.tags.has(boundary.tag)) {
      diagnostic("HN007", `Dynamic boundary <${boundary.tag}> is also present in the static component graph.`);
    }
    dynamicBoundaries.set(boundary.tag, Object.freeze({ ...boundary }));
  }
  const invocations = collectInvocationEdges(graph.nodes, graph.tags, dynamicBoundaries);

  for (const node of [...graph.nodes.values()].sort((left, right) => left.url.localeCompare(right.url))) {
    const definition: ComponentDefinition = node.controller === undefined
      ? node.definition
      : Object.freeze({ ...node.definition, controller: fileURLToPath(node.controller.url) });
    const artifact = generateComponent(definition)
      .find((candidate) => candidate.path === `vanilla/${definition.contract.name}.js`);
    if (artifact === undefined) throw new Error(`No native module was generated for ${definition.contract.tag}.`);
    const encodedURL = encodeURIComponent(node.url);
    const styleId = `${stylePrefix}${encodedURL}.css`;
    let module = artifact.content.replace(
      `../styles/${definition.contract.tag}.css`,
      styleId,
    );
    module = routeComponentInvocations(module, node, invocations.edges.get(node.url) ?? new Map(), graph.nodes);
    module = routeSupportImports(module, supportImports);
    components.set(resolvedComponentId(node.url), module);
    styles.set(`${resolvedStylePrefix}${encodedURL}.css`, definition.css);
    const capabilities = componentCapabilities(definition);
    for (const capability of capabilities) allCapabilities.add(capability);
    manifestComponents.push(Object.freeze({
      name: definition.contract.name,
      tag: definition.contract.tag,
      source: displayPath(root, node.url),
      dependencies: Object.freeze(node.dependencies.map((url) => displayPath(root, url))),
      capabilities,
    }));
  }

  const publicEntries = graph.roots.map((url) => {
    const node = graph.nodes.get(url)!;
    return Object.freeze({
      name: node.definition.contract.name,
      tag: node.definition.contract.tag,
      source: displayPath(root, url),
      module: delivery === "library" ? componentModule(node.definition.contract.tag) : componentsModule,
    });
  });
  for (const entry of publicEntries) {
    const url = graph.tags.get(entry.tag)!;
    publicComponents.set(
      publicComponentId(entry.tag),
      `export { create${entry.name} } from ${JSON.stringify(componentId(url))};\n`,
    );
  }
  const entry = publicEntries.map((item) =>
    `export { create${item.name} } from ${JSON.stringify(
      delivery === "library" ? componentModule(item.tag) : componentId(graph.tags.get(item.tag)!),
    )};`
  ).join("\n") + "\n";
  const dynamicManifest = [...dynamicBoundaries.values()].sort((left, right) => left.tag.localeCompare(right.tag))
    .map((boundary) => Object.freeze({
      ...boundary,
      usedBy: Object.freeze(
        [...(invocations.dynamicUses.get(boundary.tag) ?? [])]
          .map((url) => displayPath(root, url))
          .sort(),
      ),
    }));
  const sortedSupportImports = Object.freeze([...supportImports].sort());
  const sortedCapabilities = Object.freeze([...allCapabilities].sort());

  return Object.freeze({
    entry,
    components,
    publicComponents,
    styles,
    support: supportSource(supportImports),
    sourceFiles: Object.freeze([...graph.nodes.keys()].map((url) => fileURLToPath(url))),
    manifest: Object.freeze({
      mode: "native-application-or-library-build",
      delivery,
      entries: Object.freeze(entryURLs.map((url) => displayPath(root, url))),
      publicEntries: Object.freeze(publicEntries),
      components: Object.freeze(manifestComponents),
      capabilities: sortedCapabilities,
      supportImports: sortedSupportImports,
      support: Object.freeze({
        module: supportModule,
        imports: sortedSupportImports,
        capabilities: sortedCapabilities,
      }),
      dynamicBoundaries: Object.freeze(dynamicManifest),
    }),
  });
}

export const htmlNext = createUnplugin<HtmlNextPluginOptions>((options) => {
  let compiled: Promise<CompiledGraph> | undefined;
  const graph = (): Promise<CompiledGraph> => compiled ??= compileGraph(options);

  return {
    name: "html-next",
    enforce: "pre",
    async buildStart() {
      compiled = compileGraph(options);
      const current = await compiled;
      for (const file of current.sourceFiles) this.addWatchFile(file);
    },
    resolveId(id) {
      if (id === componentsModule) return resolvedComponentsModule;
      if (id === supportModule) return resolvedSupportModule;
      if (id.startsWith(publicComponentPrefix)) {
        return publicComponentId(decodeURIComponent(id.slice(publicComponentPrefix.length)));
      }
      if (id.startsWith(componentPrefix)) return `\0${id}`;
      if (id.startsWith(stylePrefix)) return `\0${id}`;
      return null;
    },
    load(id) {
      if (
        id !== resolvedComponentsModule &&
        id !== resolvedSupportModule &&
        !id.startsWith(resolvedPublicComponentPrefix) &&
        !id.startsWith(resolvedComponentPrefix) &&
        !id.startsWith(resolvedStylePrefix)
      ) return null;
      return graph().then((current) => {
        if (id === resolvedComponentsModule) return current.entry;
        if (id === resolvedSupportModule) return current.support;
        if (id.startsWith(resolvedPublicComponentPrefix)) {
          if (current.manifest.delivery !== "library") {
            diagnostic("HN008", "Stable public component modules are available only in library mode.");
          }
          const publicComponent = current.publicComponents.get(id);
          if (publicComponent === undefined) {
            diagnostic(
              "HN011",
              `No configured public library entry declares <${decodeURIComponent(id.slice(resolvedPublicComponentPrefix.length))}>.`,
            );
          }
          return publicComponent;
        }
        return current.components.get(id) ?? current.styles.get(id) ?? null;
      });
    },
    async generateBundle() {
      const fileName = options.manifestFile === undefined ? "html-next.manifest.json" : options.manifestFile;
      if (fileName === false) return;
      const current = await graph();
      (this as unknown as { emitFile(file: { type: "asset"; fileName: string; source: string }): string }).emitFile({
        type: "asset",
        fileName,
        source: `${JSON.stringify(current.manifest, null, 2)}\n`,
      });
    },
  };
});

export default htmlNext;
