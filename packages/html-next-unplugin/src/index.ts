import { relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  generateComponent,
  HtmlDiagnosticError,
  loadNodeComponents,
  parseTypedValue,
  type ComponentDefinition,
  type ComponentGraphNode,
  type ElementNode,
  type TemplateNode,
} from "@nextwebwg/html-next";
import { createUnplugin } from "unplugin";
import { frameworkVitePlugin, type FrameworkPluginOptions } from "./framework.js";
import { componentSources, sourcePackages } from "./source-packages.js";
export { syncHtmlNext, type FrameworkPluginOptions, type FrameworkSyncResult } from "./framework.js";

export const componentsModule = "virtual:html-next/components";
export const supportModule = "virtual:html-next/support";
const resolvedComponentsModule = "\0html-next:components";
const resolvedSupportModule = "\0html-next:support";
const resolvedPackagePrefix = "\0html-next:package:";
const publicComponentPrefix = `${componentsModule}/`;
const resolvedPublicComponentPrefix = "\0html-next:public-component:";
const componentPrefix = "html-next:component:";
const resolvedComponentPrefix = `\0${componentPrefix}`;
const stylePrefix = "html-next:style:";
const resolvedStylePrefix = `\0${stylePrefix}`;

export interface HtmlNextNativePluginOptions {
  /** Local entries; installed HTML source folders are discovered automatically. */
  readonly entries?: readonly string[];
  readonly root?: string;
  readonly manifestFile?: string | false;
  readonly mode?: "application" | "library";
  readonly dynamicBoundaries?: readonly HtmlNextDynamicBoundary[];
  /**
   * Experimental: compile eligible controller components (declared state, `$if`, keyed `$each`)
   * to direct DOM updates instead of the general runtime. Other components are unchanged.
   */
  readonly experimentalDirectExtend?: boolean;
}

export type HtmlNextPluginOptions = HtmlNextNativePluginOptions | FrameworkPluginOptions;

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
  readonly packages: ReadonlyMap<string, string>;
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

function propAttributeName(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
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
        uses.add(node.id);
        dynamicUses.set(tag, uses);
        return;
      }
      const target = tags.get(tag);
      // Siblings share their resource scope without materializing every possible sibling edge.
      if (target === undefined || (!node.dependencies.includes(target) && nodes.get(target)?.url !== node.url)) {
        diagnostic(
          "HN001",
          `Component invocation <${tag}> is not a declared static dependency or dynamic boundary.`,
          node.url,
        );
      }
      invoked.set(tag, target);
    });
    edges.set(node.id, invoked);
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

/**
 * The generated factory can carry literal invocation data. Its prop values are parsed at build
 * time with the same declared contract the runtime uses; the remaining attributes use the
 * factory's existing root-attribute path (including class/style merging). Nothing here needs a
 * parent-to-child update channel.
 */
interface FactoryInvocationOptions {
  readonly attributes: readonly [string, string][];
  readonly props: readonly [string, unknown][];
  /** The authored attribute spelling, used to remove the parent emitter's duplicate write. */
  readonly literals: readonly [string, string][];
  /** The declared slot each static projected child targets; `""` is the default slot. */
  readonly projectedSlots: readonly string[];
}

function staticProjectionSupported(node: TemplateNode, root = true): boolean {
  if (node.kind === "text") return true;
  if (node.kind === "slot") return false;
  const staticComponent = node.name.includes("-") && node.children.length === 0 && node.attributes.every((attribute) =>
    attribute.kind === "literal" && attribute.name !== "data-component"
  );
  return (!node.name.includes("-") || staticComponent) && node.flow === undefined && node.ref === undefined &&
    (node.events?.length ?? 0) === 0 && node.attributes.every((attribute) =>
      attribute.kind === "literal" && (root || attribute.name !== "slot")
    ) && node.children.every((child) => staticProjectionSupported(child, false));
}

function projectedSlotName(node: TemplateNode): string {
  if (node.kind !== "element") return "";
  for (const attribute of node.attributes) {
    if (attribute.kind === "literal" && attribute.name === "slot") return attribute.value;
  }
  return "";
}

function factoryInvocationOptions(
  invocation: ElementNode,
  definition: ComponentDefinition,
): FactoryInvocationOptions | undefined {
  if (invocation.flow !== undefined || invocation.ref !== undefined || (invocation.events?.length ?? 0) > 0) return undefined;
  const projectedSlots = invocation.children.map(projectedSlotName);
  const declaredSlots = new Set((definition.slots ?? []).map((slot) => slot.name ?? ""));
  if (projectedSlots.length > 0 && (
    !invocation.children.every((child) => staticProjectionSupported(child)) ||
    projectedSlots.some((slot) => !declaredSlots.has(slot))
  )) return undefined;
  const propAttributes = new Map(Object.keys(definition.contract.props).map((name) => [propAttributeName(name), name]));
  const attributes: [string, string][] = [];
  const props: [string, unknown][] = [];
  const literals: [string, string][] = [];
  for (const attribute of invocation.attributes) {
    if (attribute.kind !== "literal" || attribute.name === "data-component") return undefined;
    literals.push([attribute.name, attribute.value]);
    const propName = propAttributes.get(attribute.name.toLowerCase());
    if (propName === undefined) {
      attributes.push([attribute.name, attribute.value]);
      continue;
    }
    // Factory options reserve these keys for invocation data, not component props.
    if (propName === "attributes" || propName === "children" || propName === "slots") return undefined;
    const contract = definition.contract.props[propName]!;
    const input = contract.type === "boolean" && attribute.value === "" ? true : attribute.value;
    const parsed = parseTypedValue(input, contract.type);
    if (!parsed.ok) return undefined;
    props.push([propName, parsed.value]);
  }
  return { attributes, props, literals, projectedSlots };
}

/**
 * Checks the invocations a factory-compiled parent contains. Such a parent emits plain DOM, so an
 * invocation becomes a factory call carrying static invocation data and projected nodes grouped by
 * the child's declared slots. A parent the general runtime renders has no such limit: it renders
 * the invocation itself.
 */
function assertCompilableInvocations(
  node: ComponentGraphNode,
  invoked: ReadonlyMap<string, string>,
  nodes: ReadonlyMap<string, ComponentGraphNode>,
): void {
  visitComponentNodes(node.definition.template, (invocation) => {
    const target = invoked.get(invocation.name);
    if (target === undefined) return;
    const options = factoryInvocationOptions(invocation, nodes.get(target)!.definition);
    if (options === undefined) {
      diagnostic(
        "HN009",
        `Compiled invocation <${invocation.name}> cannot yet carry dynamic or unsupported attributes, projected children, ` +
        "events, refs, or structural flow. A component the general runtime renders can.",
        node.url,
      );
    }
    if (Object.entries(nodes.get(target)!.definition.contract.props).some(([name, prop]) =>
      prop.required && !options.props.some(([provided]) => provided === name)
    )) {
      diagnostic(
        "HN014",
        `Compiled invocation <${invocation.name}> requires an input that the compiled invocation did not provide. ` +
          "A component the general runtime renders can.",
        node.url,
      );
    }
  });
}

function supportSource(
  imports: ReadonlySet<string>,
  runtimeRendered: ReadonlyMap<string, ComponentDefinition>,
): string {
  const lines: string[] = [];
  // Generated modules import whichever helpers their features use; re-exporting the whole entry
  // keeps every one of them resolvable, and the bundler still drops what nothing imports.
  for (const source of ["@nextwebwg/html-next/generated-runtime", "@nextwebwg/html-next/runtime"]) {
    if (imports.has(source)) lines.push(`export * from ${JSON.stringify(source)};`);
  }
  if (runtimeRendered.size > 0) {
    // Components another component's template invokes, where the general runtime renders that
    // template. It builds them from these definitions; their styles arrive through the CSS each
    // generated module imports, so the registered copies carry none.
    const definitions = [...runtimeRendered.values()]
      .map((definition) => JSON.stringify({ ...definition, css: "" }));
    lines.push(
      'import { registerComponentDefinitions } from "@nextwebwg/html-next/runtime";',
      `const renderedComponents = [
${definitions.map((text) => `  ${text},`).join("\n")}
];`,
      "let registered = false;",
      "export function registerRenderedComponents(root) {",
      "  if (registered) return;",
      "  registered = true;",
      "  registerComponentDefinitions(renderedComponents, root);",
      "}",
    );
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

/**
 * Wires the components a runtime-rendered template invokes. The runtime renders the template, so
 * the invocations stay in it; it needs their definitions registered, and each one's stylesheet has
 * to reach the build even though nothing imports its factory.
 */
function routeRenderedInvocations(
  module: string,
  invoked: ReadonlyMap<string, string>,
  nodes: ReadonlyMap<string, ComponentGraphNode>,
  rendered: Map<string, ComponentDefinition>,
): string {
  const imports = [`import { registerRenderedComponents } from ${JSON.stringify(supportModule)};`];
  for (const [, url] of invoked) {
    const target = nodes.get(url)!;
    rendered.set(url, target.definition);
    if (target.definition.css !== "") {
      imports.push(`import ${JSON.stringify(`${stylePrefix}${encodeURIComponent(url)}.css`)};`);
    }
  }
  const call = "  registerRenderedComponents(element.ownerDocument);";
  const routed = module.replace(
    /^(\s*)manageComponentLifecycle\(/m,
    `${call}
$1manageComponentLifecycle(`,
  );
  return `${imports.join("\n")}\n${routed}`;
}

function routeComponentInvocations(
  module: string,
  node: ComponentGraphNode,
  invoked: ReadonlyMap<string, string>,
  nodes: ReadonlyMap<string, ComponentGraphNode>,
): string {
  if (invoked.size === 0) return module;
  const imports: string[] = [];
  let routed = module;
  for (const [tag, url] of invoked) {
    const target = nodes.get(url)!;
    const factory = `create${target.definition.contract.name}`;
    imports.push(`import { ${factory} } from ${JSON.stringify(componentId(url))};`);
    const creation = `document.createElement(${JSON.stringify(tag)})`;
    const options: Array<ReturnType<typeof factoryInvocationOptions>> = [];
    visitComponentNodes(node.definition.template, (invocation) => {
      if (invocation.name !== tag) return;
      options.push(factoryInvocationOptions(invocation, target.definition));
    });
    let invocation = 0;
    const removeAttributeLines = new Set<string>();
    const variables = new Map<string, FactoryInvocationOptions>();
    routed = routed.split("\n").flatMap((line) => {
      const match = line.match(
        new RegExp(`^(\\s*)const ([A-Za-z_$][A-Za-z0-9_$]*) = ${escapePattern(creation)};$`),
      );
      if (match === null) return removeAttributeLines.has(line) ? [] : [line];
      const literalOptions = options[invocation++]!;
      if (literalOptions === undefined) return [line];
      variables.set(match[2]!, literalOptions);
      for (const [name, value] of literalOptions.literals) {
        removeAttributeLines.add(`${match[1]}${match[2]}.setAttribute(${JSON.stringify(name)}, ${JSON.stringify(value)});`);
      }
      const properties = [
        ...(literalOptions.attributes.length === 0 ? [] : [`attributes: ${JSON.stringify(Object.fromEntries(literalOptions.attributes))}`]),
        ...literalOptions.props.map(([name, value]) => `${JSON.stringify(name)}: ${JSON.stringify(value)}`),
      ];
      const factoryOptions = properties.length === 0 ? "" : `({ ${properties.join(", ")} })`;
      return literalOptions.projectedSlots.length > 0 ? [line] : [`${match[1]}const ${match[2]} = ${factory}(${factoryOptions});`];
    }).join("\n");
    if (variables.size === 0) {
      diagnostic("HN013", `The native generator did not expose compiled invocation <${tag}>.`, node.url);
    }
    for (const [variable, invocationOptions] of variables) {
      if (invocationOptions.projectedSlots.length > 0) {
        const content = `${variable}Children`;
        const slotEntries = new Map<string, string[]>();
        for (const [index, slot] of invocationOptions.projectedSlots.entries()) {
          const nodes = slotEntries.get(slot) ?? [];
          nodes.push(`${content}[${index}]`);
          slotEntries.set(slot, nodes);
        }
        const properties = [
          ...(invocationOptions.attributes.length === 0 ? [] : [`attributes: ${JSON.stringify(Object.fromEntries(invocationOptions.attributes))}`]),
          ...invocationOptions.props.map(([name, value]) => `${JSON.stringify(name)}: ${JSON.stringify(value)}`),
          ...(slotEntries.get("") === undefined ? [] : [`children: [${slotEntries.get("")!.join(", ")}]`]),
          ...(slotEntries.size === (slotEntries.has("") ? 1 : 0) ? [] : [
            `slots: { ${[...slotEntries.entries()].filter(([slot]) => slot !== "").map(([slot, nodes]) =>
              `${JSON.stringify(slot)}: [${nodes.join(", ")}]`).join(", ")} }`,
          ]),
        ];
        const compiled = `${variable}Projected`;
        routed = routed.replace(
          new RegExp(`^(\\s*)([A-Za-z_$][A-Za-z0-9_$]*)\\.append\\(${escapePattern(variable)}\\);$`, "m"),
          `$1const ${content} = Array.from(${variable}.childNodes);\n$1const ${compiled} = ${factory}({ ${properties.join(", ")} });\n$1$2.append(${compiled});`,
        );
      }
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

async function compileGraph(options: HtmlNextNativePluginOptions): Promise<CompiledGraph> {
  const root = resolve(options.root ?? process.cwd());
  const installed = await sourcePackages(root);
  const packageEntries = new Map<string, string[]>();
  for (const library of installed) {
    for (const { specifier, source } of library.exports) {
      const files = await componentSources(source, library.directory);
      // Authored JS/TS barrels remain a framework-adapter feature.
      if (files.length > 0) packageEntries.set(specifier, files);
    }
  }
  const delivery = options.mode ?? "application";
  if (delivery !== "application" && delivery !== "library") {
    diagnostic("HN012", `Unknown native build mode \`${String(delivery)}\`.`);
  }
  const localURLs = (options.entries ?? []).map((entry) => pathToFileURL(resolve(root, entry)).href);
  if (new Set(localURLs).size !== localURLs.length) {
    diagnostic("HN004", "A component entry may be configured only once.");
  }
  const entryURLs = [...new Set([...localURLs, ...[...packageEntries.values()].flat().map((file) => pathToFileURL(file).href)])];
  if (entryURLs.length === 0) throw new Error("HTML Next requires at least one component entry or an installed HTML source package.");
  const graph = await loadNodeComponents(entryURLs, { baseURL: pathToFileURL(`${root}${sep}`).href });
  const components = new Map<string, string>();
  const publicComponents = new Map<string, string>();
  const styles = new Map<string, string>();
  const manifestComponents: HtmlNextBuildManifest["components"][number][] = [];
  const allCapabilities = new Set<string>();
  const supportImports = new Set<string>();
  /** Definitions the general runtime builds because a runtime-rendered template invokes them. */
  const renderedComponents = new Map<string, ComponentDefinition>();
  const dynamicBoundaries = new Map<string, HtmlNextDynamicBoundary>();
  const generatedNames = new Map<string, string>();

  for (const node of graph.nodes.values()) {
    const name = node.definition.contract.name;
    const prior = generatedNames.get(name);
    if (prior !== undefined && prior !== node.id) {
      diagnostic("HN010", `Generated factory name \`${name}\` collides with ${prior}.`, node.url);
    }
    generatedNames.set(name, node.id);
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
  const contextProviders = new Set(
    [...graph.nodes.values()].flatMap((node) =>
      (node.definition.declarations ?? [])
        .filter((declaration) => declaration.kind === "context")
        .map((declaration) => declaration.from),
    ),
  );

  for (const node of [...graph.nodes.values()].sort((left, right) => left.url.localeCompare(right.url))) {
    const definition: ComponentDefinition = node.controller === undefined
      ? node.definition
      : Object.freeze({ ...node.definition, controller: fileURLToPath(node.controller.url) });
    const artifacts = generateComponent(definition, {
      noContextReaders: dynamicBoundaries.size === 0 && !contextProviders.has(definition.contract.tag),
      directExtend: options.experimentalDirectExtend === true,
    });
    const artifact = artifacts.find((candidate) => candidate.path === `vanilla/${definition.contract.name}.js`);
    if (artifact === undefined) throw new Error(`No native module was generated for ${definition.contract.tag}.`);
    const encodedURL = encodeURIComponent(node.id);
    const styleId = `${stylePrefix}${encodedURL}.css`;
    let module = artifact.content.replace(
      `../styles/${definition.contract.tag}.css`,
      styleId,
    );
    const invoked = invocations.edges.get(node.id) ?? new Map<string, string>();
    if (invoked.size > 0 && module.includes("manageComponentLifecycle")) {
      // The general runtime renders this template, so it renders the invocations too.
      module = routeRenderedInvocations(module, invoked, graph.nodes, renderedComponents);
    } else {
      assertCompilableInvocations(node, invoked, graph.nodes);
      module = routeComponentInvocations(module, node, invoked, graph.nodes);
    }
    module = routeSupportImports(module, supportImports);
    components.set(resolvedComponentId(node.id), module);
    styles.set(`${resolvedStylePrefix}${encodedURL}.css`, artifacts.find((candidate) => candidate.path === `styles/${definition.contract.tag}.css`)!.content);
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
  const packages = new Map<string, string>();
  for (const [specifier, files] of packageEntries) {
    const urls = new Set(files.map((file) => pathToFileURL(file).href));
    packages.set(specifier, graph.roots.filter((id) => urls.has(graph.nodes.get(id)!.url)).map((id) => {
      const node = graph.nodes.get(id)!;
      return `export { create${node.definition.contract.name} } from ${JSON.stringify(componentId(id))};`;
    }).join("\n") + "\n");
  }
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
    packages,
    components,
    publicComponents,
    styles,
    support: supportSource(supportImports, renderedComponents),
    sourceFiles: Object.freeze([...new Set([...graph.nodes.values()].map((node) => fileURLToPath(node.url))), ...installed.map((library) => library.manifest)]),
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

export const htmlNext = createUnplugin<HtmlNextPluginOptions | undefined>((options = {}, meta) => {
  if ("target" in options) {
    if (meta.framework !== "vite") throw new Error("Automatic framework conversion currently requires the Vite adapter.");
    return { name: "html-next-framework", vite: frameworkVitePlugin(options) };
  }
  let compiled: Promise<CompiledGraph> | undefined;
  let root = options.root ?? process.cwd();
  const graph = (): Promise<CompiledGraph> => compiled ??= compileGraph({ ...options, root });

  return {
    name: "html-next",
    enforce: "pre",
    vite: { configResolved(config) { root = options.root ?? config.root; } },
    async buildStart() {
      compiled = compileGraph({ ...options, root });
      const current = await compiled;
      for (const file of current.sourceFiles) this.addWatchFile(file);
    },
    async resolveId(id, importer) {
      if (importer === resolvedSupportModule && (id === "@nextwebwg/html-next/generated-runtime" || id === "@nextwebwg/html-next/runtime")) {
        return fileURLToPath(import.meta.resolve(id));
      }
      if (id === componentsModule) return resolvedComponentsModule;
      if (id === supportModule) return resolvedSupportModule;
      if (id.startsWith(publicComponentPrefix)) {
        return publicComponentId(decodeURIComponent(id.slice(publicComponentPrefix.length)));
      }
      if (id.startsWith(componentPrefix)) return `\0${id}`;
      if (id.startsWith(stylePrefix)) return `\0${id}`;
      if ((await graph()).packages.has(id)) return `${resolvedPackagePrefix}${id}`;
      return null;
    },
    load(id) {
      if (
        id !== resolvedComponentsModule &&
        id !== resolvedSupportModule &&
        !id.startsWith(resolvedPublicComponentPrefix) &&
        !id.startsWith(resolvedComponentPrefix) &&
        !id.startsWith(resolvedStylePrefix) &&
        !id.startsWith(resolvedPackagePrefix)
      ) return null;
      return graph().then((current) => {
        if (id === resolvedComponentsModule) return current.entry;
        if (id === resolvedSupportModule) return current.support;
        if (id.startsWith(resolvedPackagePrefix)) return current.packages.get(id.slice(resolvedPackagePrefix.length)) ?? null;
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
