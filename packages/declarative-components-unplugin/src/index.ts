import { relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  generateComponent,
  loadNodeComponents,
  type ComponentDefinition,
  type TemplateNode,
} from "@nextwebwg/declarative-components";
import { createUnplugin } from "unplugin";

export const componentsModule = "virtual:html-next/components";
const resolvedComponentsModule = "\0html-next:components";
const componentPrefix = "html-next:component:";
const resolvedComponentPrefix = `\0${componentPrefix}`;
const stylePrefix = "html-next:style:";
const resolvedStylePrefix = `\0${stylePrefix}`;

export interface HtmlNextPluginOptions {
  readonly entries: readonly string[];
  readonly root?: string;
  readonly manifestFile?: string | false;
}

export interface HtmlNextBuildManifest {
  readonly mode: "native-application-or-library-build";
  readonly entries: readonly string[];
  readonly components: readonly {
    readonly name: string;
    readonly tag: string;
    readonly source: string;
    readonly dependencies: readonly string[];
    readonly capabilities: readonly string[];
  }[];
  readonly capabilities: readonly string[];
  readonly supportImports: readonly string[];
}

interface CompiledGraph {
  readonly entry: string;
  readonly components: ReadonlyMap<string, string>;
  readonly styles: ReadonlyMap<string, string>;
  readonly sourceFiles: readonly string[];
  readonly manifest: HtmlNextBuildManifest;
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
  if ((node.events?.length ?? 0) > 0) capabilities.add("event-handlers");
  if (node.ref !== undefined) capabilities.add("refs");
  for (const attribute of node.attributes) {
    if (attribute.kind === "literal") continue;
    capabilities.add(attribute.kind === "directive" ? attribute.name : "bindings");
    if (attribute.kind === "attribute" && attribute.twoWay === true) capabilities.add("two-way-bindings");
  }
  for (const child of node.children) visitTemplate(child, capabilities);
}

export function componentCapabilities(definition: ComponentDefinition): readonly string[] {
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
  const entryURLs = options.entries.map((entry) => pathToFileURL(resolve(root, entry)).href);
  const graph = await loadNodeComponents(entryURLs, { baseURL: pathToFileURL(`${root}${sep}`).href });
  const components = new Map<string, string>();
  const styles = new Map<string, string>();
  const exports: string[] = [];
  const names = new Set<string>();
  const manifestComponents: HtmlNextBuildManifest["components"][number][] = [];
  const allCapabilities = new Set<string>();
  const supportImports = new Set<string>();

  for (const node of [...graph.nodes.values()].sort((left, right) => left.url.localeCompare(right.url))) {
    const definition: ComponentDefinition = node.controller === undefined
      ? node.definition
      : Object.freeze({ ...node.definition, controller: fileURLToPath(node.controller.url) });
    if (names.has(definition.contract.name)) {
      throw new Error(`Generated export collision for ${definition.contract.name}.`);
    }
    names.add(definition.contract.name);
    const artifact = generateComponent(definition)
      .find((candidate) => candidate.path === `vanilla/${definition.contract.name}.js`);
    if (artifact === undefined) throw new Error(`No native module was generated for ${definition.contract.tag}.`);
    const encodedURL = encodeURIComponent(node.url);
    const componentId = `${componentPrefix}${encodedURL}.js`;
    const styleId = `${stylePrefix}${encodedURL}.css`;
    const module = artifact.content.replace(
      `../styles/${definition.contract.tag}.css`,
      styleId,
    );
    components.set(`${resolvedComponentPrefix}${encodedURL}.js`, module);
    styles.set(`${resolvedStylePrefix}${encodedURL}.css`, definition.css);
    exports.push(`export { create${definition.contract.name} } from ${JSON.stringify(componentId)};`);
    const capabilities = componentCapabilities(definition);
    for (const capability of capabilities) allCapabilities.add(capability);
    if (module.includes("@nextwebwg/declarative-components/generated-runtime")) {
      supportImports.add("@nextwebwg/declarative-components/generated-runtime");
    }
    if (module.includes("@nextwebwg/declarative-components/runtime")) {
      supportImports.add("@nextwebwg/declarative-components/runtime");
    }
    manifestComponents.push(Object.freeze({
      name: definition.contract.name,
      tag: definition.contract.tag,
      source: displayPath(root, node.url),
      dependencies: Object.freeze(node.dependencies.map((url) => displayPath(root, url))),
      capabilities,
    }));
  }

  return Object.freeze({
    entry: `${exports.join("\n")}\n`,
    components,
    styles,
    sourceFiles: Object.freeze([...graph.nodes.keys()].map((url) => fileURLToPath(url))),
    manifest: Object.freeze({
      mode: "native-application-or-library-build",
      entries: Object.freeze(entryURLs.map((url) => displayPath(root, url))),
      components: Object.freeze(manifestComponents),
      capabilities: Object.freeze([...allCapabilities].sort()),
      supportImports: Object.freeze([...supportImports].sort()),
    }),
  });
}

export const htmlNext = createUnplugin<HtmlNextPluginOptions>((options) => {
  let compiled: Promise<CompiledGraph> | undefined;
  const graph = (): Promise<CompiledGraph> => compiled ??= compileGraph(options);

  return {
    name: "html-next-declarative-components",
    enforce: "pre",
    async buildStart() {
      const current = await graph();
      for (const file of current.sourceFiles) this.addWatchFile(file);
    },
    resolveId(id) {
      if (id === componentsModule) return resolvedComponentsModule;
      if (id.startsWith(componentPrefix)) return `\0${id}`;
      if (id.startsWith(stylePrefix)) return `\0${id}`;
      return null;
    },
    async load(id) {
      const current = await graph();
      if (id === resolvedComponentsModule) return current.entry;
      return current.components.get(id) ?? current.styles.get(id) ?? null;
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
