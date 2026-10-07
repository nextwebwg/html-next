import { relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  generateComponent,
  getDiagnosticLocation,
  withDiagnosticLocation,
  expandComponentEntries,
  HtmlDiagnosticError,
  HtmlDiagnosticAggregateError,
  recoverDiagnostic,
  loadNodeComponents,
  type HtmlDiagnostic,
  type DiagnosticLocation,
  type ComponentDefinition,
  type ComponentGraphNode,
  type ElementNode,
  type TemplateNode,
} from "@nextwebwg/html-next";
import {
  checkConversion,
  FrameworkConversionError,
  FrameworkDuplicateEntryError,
  FrameworkOutputCollisionError,
  FrameworkTargetVersionError,
  type CheckConversionOptions,
} from "@nextwebwg/html-next-converter";
import { createUnplugin } from "unplugin";
import { frameworkVitePlugin, type FrameworkPluginOptions } from "./framework.js";
import { componentSources, sourcePackages } from "./source-packages.js";
export { syncHtmlNext, type FrameworkPluginOptions, type FrameworkSyncResult } from "./framework.js";
export { formatCheckDiagnostic, type CheckDiagnosticFormatOptions } from "./diagnostic-format.js";

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

function diagnostic(code: string, message: string, source?: string, location?: DiagnosticLocation): never {
  throw new HtmlDiagnosticError({ code, message, ...(source === undefined ? {} : { source }), ...location });
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
  report?: (diagnostic: HtmlDiagnostic) => void,
): {
  readonly edges: ReadonlyMap<string, ReadonlyMap<string, string>>;
  readonly dynamicUses: ReadonlyMap<string, ReadonlySet<string>>;
} {
  const edges = new Map<string, ReadonlyMap<string, string>>();
  const dynamicUses = new Map<string, Set<string>>();
  for (const node of nodes.values()) {
    const invoked = new Map<string, string>();
    visitComponentNodes(node.definition.template, (invocation) => {
      try {
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
            getDiagnosticLocation(invocation),
          );
        }
        invoked.set(tag, target);
      } catch (error) { recoverDiagnostic(error, report); }
    });
    edges.set(node.id, invoked);
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (url: string): void => {
    if (visited.has(url)) return;
    if (visiting.has(url)) diagnostic("HN002", "Compiled component invocations form a cycle.", nodes.get(url)?.url ?? url, getDiagnosticLocation(nodes.get(url)!.definition));
    visiting.add(url);
    try {
      for (const target of edges.get(url)?.values() ?? []) {
        try { visit(target); }
        catch (error) { recoverDiagnostic(error, report); }
      }
    } finally { visiting.delete(url); }
    visited.add(url);
  };
  for (const url of nodes.keys()) {
    try { visit(url); }
    catch (error) { recoverDiagnostic(error, report); }
  }

  return { edges, dynamicUses };
}

function supportSource(imports: ReadonlySet<string>): string {
  const lines: string[] = [];
  // Generated modules import whichever helpers their features use; re-exporting the whole entry
  // keeps every one of them resolvable, and the bundler still drops what nothing imports.
  for (const source of ["@nextwebwg/html-next/generated-runtime", "@nextwebwg/html-next/runtime"]) {
    if (imports.has(source)) lines.push(`export * from ${JSON.stringify(source)};`);
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

async function compileGraph(options: HtmlNextNativePluginOptions, collectDiagnostics = false): Promise<CompiledGraph> {
  const diagnostics: HtmlDiagnostic[] = [];
  const report = collectDiagnostics ? (diagnostic: HtmlDiagnostic): void => { diagnostics.push(diagnostic); } : undefined;
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
  const entries = await expandComponentEntries(root, options.entries ?? []);
  const localURLs = entries.map((entry) => pathToFileURL(resolve(root, entry)).href);
  if (new Set(localURLs).size !== localURLs.length) {
    diagnostic("HN004", "A component entry may be configured only once.");
  }
  const entryURLs = [...new Set([...localURLs, ...[...packageEntries.values()].flat().map((file) => pathToFileURL(file).href)])];
  if (entryURLs.length === 0) throw new Error("HTML Next requires at least one component entry or an installed HTML source package.");
  const graph = await loadNodeComponents(entryURLs, { baseURL: pathToFileURL(`${root}${sep}`).href, collectDiagnostics });
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
    if (prior !== undefined && prior !== node.id) {
      diagnostic("HN010", `Generated factory name \`${name}\` collides with ${prior}.`, node.url, getDiagnosticLocation(node.definition));
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
  const invocations = collectInvocationEdges(graph.nodes, graph.tags, dynamicBoundaries, report);
  if (diagnostics.length > 0) throw new HtmlDiagnosticAggregateError(diagnostics);
  const contextProviders = new Set(
    [...graph.nodes.values()].flatMap((node) =>
      (node.definition.declarations ?? [])
        .filter((declaration) => declaration.kind === "context")
        .map((declaration) => declaration.from),
    ),
  );

  const sortedNodes = [...graph.nodes.values()].sort((left, right) => left.url.localeCompare(right.url));
  const generated = sortedNodes.flatMap((node) => {
    try {
      const definition: ComponentDefinition = node.controller === undefined
        ? node.definition
        : Object.freeze({ ...node.definition, controller: fileURLToPath(node.controller.url) });
      const artifacts = withDiagnosticLocation(getDiagnosticLocation(node.definition), () => generateComponent(definition, {
        noContextReaders: dynamicBoundaries.size === 0 && !contextProviders.has(definition.contract.tag),
        // Each component the template invokes, by the module exporting its factory.
        invocations: new Map([...invocations.edges.get(node.id) ?? []].map(([tag, url]) =>
          [tag, { module: componentId(url), definition: graph.nodes.get(url)!.definition }])),
      }));
      const artifact = artifacts.find((candidate) => candidate.path === `vanilla/${definition.contract.name}.js`);
      if (artifact === undefined) throw new Error(`No native module was generated for ${definition.contract.tag}.`);
      return [{ node, definition, artifacts, artifact }];
    } catch (error) {
      recoverDiagnostic(error, report);
      return [];
    }
  });

  for (const { node, definition, artifacts, artifact } of generated) {
    try {
      const encodedURL = encodeURIComponent(node.id);
      const styleId = `${stylePrefix}${encodedURL}.css`;
      let module = artifact.content.replace(
        `../styles/${definition.contract.tag}.css`,
        styleId,
      );
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
    } catch (error) { recoverDiagnostic(error, report); }
  }
  if (diagnostics.length > 0) throw new HtmlDiagnosticAggregateError(diagnostics);

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
    support: supportSource(supportImports),
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

export type HtmlNextCheckOptions =
  | (HtmlNextNativePluginOptions & { readonly target?: "native" })
  | CheckConversionOptions;

export interface HtmlNextCheckDiagnostic extends HtmlDiagnostic {
  readonly severity: "error";
}

/**
 * Runs the selected build backend without emitting files or executing controllers.
 * Returns collected independent compiler diagnostics, or an empty array on success. Operational
 * failures without a compiler diagnostic reject the promise.
 */
export async function checkHtmlNext(options: HtmlNextCheckOptions = {}): Promise<readonly HtmlNextCheckDiagnostic[]> {
  try {
    if (options.target === "vue" || options.target === "react" || options.target === "svelte") await checkConversion(options);
    else await compileGraph(options, true);
    return Object.freeze([]);
  } catch (error) {
    let diagnostic: HtmlDiagnostic;
    if (error instanceof HtmlDiagnosticAggregateError) return checkDiagnostics(error.diagnostics);
    if (error instanceof HtmlDiagnosticError) diagnostic = error.diagnostic;
    else if (error instanceof FrameworkConversionError || error instanceof FrameworkDuplicateEntryError) {
      diagnostic = { code: error.code, message: error.message, source: error.source, ...(error instanceof FrameworkConversionError ? error.location : {}) };
    } else if (error instanceof FrameworkOutputCollisionError) {
      diagnostic = { code: error.code, message: error.message, source: error.sources[1] };
    } else if (error instanceof FrameworkTargetVersionError) {
      diagnostic = { code: error.code, message: error.message };
    } else throw error;
    return checkDiagnostics([diagnostic]);
  }
}

function checkDiagnostics(diagnostics: readonly HtmlDiagnostic[]): readonly HtmlNextCheckDiagnostic[] {
  const unique = new Map(diagnostics.map((diagnostic) => [
    JSON.stringify([diagnostic.source, diagnostic.line, diagnostic.column, diagnostic.code, diagnostic.message]), diagnostic,
  ]));
  return Object.freeze([...unique.values()].sort((left, right) =>
    (left.source ?? "").localeCompare(right.source ?? "") ||
    (left.line ?? 0) - (right.line ?? 0) || (left.column ?? 0) - (right.column ?? 0) || left.code.localeCompare(right.code)
  ).map((diagnostic) => Object.freeze({ ...diagnostic, severity: "error" as const })));
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
