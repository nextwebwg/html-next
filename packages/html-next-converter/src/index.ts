import { mkdir, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  addControllerGraph,
  generateVueComponent,
  HtmlDiagnosticError,
  importsVueHost,
  importsVueHtml,
  importsVueControl,
  importsVueProps,
  loadNodeComponents,
  vueHostArtifact,
  vueHtmlArtifact,
  vueControlArtifact,
  vuePropsArtifact,
  type ComponentGraph,
  type TemplateNode,
  type GeneratedArtifact,
} from "@nextwebwg/html-next";

export type FrameworkTarget = "vue";
export type ConversionGraph = "application" | "library";

const targetVersions: Readonly<Record<FrameworkTarget, string>> = {
  vue: "3.5",
};

interface BaseConvertOptions {
  readonly entries: readonly string[];
  readonly target: FrameworkTarget;
  readonly targetVersion?: string;
  readonly outDirectory: string;
  readonly root?: string;
  /** Browser URL of `root`, required when a data source is relative to its component file. */
  readonly publicRootURL?: string;
}

export interface ApplicationConvertOptions extends BaseConvertOptions {
  readonly mode: "application";
}

export interface LibraryConvertOptions extends BaseConvertOptions {
  readonly mode: "library";
}

export type ConvertOptions = ApplicationConvertOptions | LibraryConvertOptions;

export interface ConversionEntry {
  readonly source: string;
  readonly tag: string;
  readonly artifact: string;
}

export interface ConversionOutput {
  readonly path: string;
  readonly kind: "component" | "controller" | "helper" | "entry" | "inventory";
  readonly source?: string;
}

export interface ConversionManifest {
  readonly mode: "framework-conversion";
  readonly target: FrameworkTarget;
  readonly targetVersion: string;
  readonly graph: ConversionGraph;
  readonly entries: readonly ConversionEntry[];
  readonly output: {
    readonly entry: string;
    readonly inventory: "html-next.conversion.json";
    readonly artifacts: readonly ConversionOutput[];
  };
  readonly components: readonly {
    readonly name: string;
    readonly tag: string;
    readonly source: string;
    readonly artifact: string;
    /** The copied controller module the component imports, if it has one. */
    readonly controller?: string;
  }[];
}

export class FrameworkOutputCollisionError extends Error {
  readonly code = "HTC002";

  constructor(
    readonly target: FrameworkTarget,
    readonly artifact: string,
    readonly sources: readonly [string, string],
  ) {
    super(
      `${sources[1]}: HTC002: ${target} output \`${artifact}\` collides with output from ${sources[0]}. Rename one component so each generated artifact has a distinct path.`,
    );
    this.name = "FrameworkOutputCollisionError";
  }
}

export class FrameworkDuplicateEntryError extends Error {
  readonly code = "HTC002";

  constructor(readonly source: string) {
    super(`${source}: HTC002: component entry is listed more than once.`);
    this.name = "FrameworkDuplicateEntryError";
  }
}

export class FrameworkTargetVersionError extends Error {
  readonly code = "HTC003";

  constructor(
    readonly target: FrameworkTarget,
    readonly requested: string,
    readonly supported: string,
  ) {
    super(`HTC003: ${target} ${requested} is not supported; this converter targets ${target} ${supported}.`);
    this.name = "FrameworkTargetVersionError";
  }
}

export class FrameworkConversionError extends Error {
  readonly code = "HTC001";

  constructor(
    readonly target: FrameworkTarget,
    readonly source: string,
    readonly tag: string,
    readonly reason?: string,
  ) {
    super(
      `${source}: HTC001: ${target} conversion of <${tag}> failed${reason === undefined ? "" : `: ${reason}`}`,
    );
    this.name = "FrameworkConversionError";
  }
}



async function emit(root: string, artifact: GeneratedArtifact): Promise<void> {
  const output = resolve(root, artifact.path);
  if (output !== root && !output.startsWith(`${root}${sep}`)) {
    throw new Error(`Generated artifact escaped the output directory: ${artifact.path}.`);
  }
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, artifact.content, "utf8");
}

function frameworkEntry(
  mode: ConversionGraph,
  target: FrameworkTarget,
  entries: readonly ConversionEntry[],
): GeneratedArtifact {
  const exports = [...entries].sort((left, right) => left.artifact.localeCompare(right.artifact)).map((entry) => {
    const artifact = entry.artifact.slice(entry.artifact.lastIndexOf("/") + 1);
    const name = artifact.replace(/\.vue$/, "");
    return `export { default as ${name} } from ${JSON.stringify(`./${artifact}`)};`;
  });
  return {
    path: `${target}/${mode === "application" ? "application.ts" : "index.ts"}`,
    content: `${exports.join("\n")}\n`,
  };
}

function componentRelativeDataSource(source: string): boolean {
  return !source.startsWith("/") && !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(source);
}

function browserDefinitionURL(
  definition: { readonly declarations?: readonly { readonly kind: string; readonly source?: string }[] },
  source: string,
  publicRootURL: string | undefined,
  target: FrameworkTarget,
  tag: string,
): string {
  const relativeData = definition.declarations?.some((declaration) =>
    declaration.kind === "data" && declaration.source !== undefined && componentRelativeDataSource(declaration.source)) ?? false;
  if (relativeData && publicRootURL === undefined) {
    throw new FrameworkConversionError(target, source, tag, "component-relative <data src> requires publicRootURL, the browser URL corresponding to the conversion root");
  }
  if (publicRootURL === undefined) return "";
  if (!publicRootURL.endsWith("/") || !/^(?:\/|https?:\/\/)/.test(publicRootURL) || /[?#]/.test(publicRootURL) || source.startsWith("../")) {
    throw new FrameworkConversionError(target, source, tag, "publicRootURL must be an HTTP(S) or root-relative directory URL, and the component must be inside the conversion root");
  }
  return `${publicRootURL}${source.split("/").map(encodeURIComponent).join("/")}`;
}

/** Only graphs with an invocation cycle or a path past 32 nested components need HR008 checks. */
function needsNestedDepthGuard(graph: ComponentGraph): boolean {
  const edges = new Map<string, Set<string>>();
  for (const node of graph.nodes.values()) {
    const children = new Set<string>();
    const visit = (template: TemplateNode): void => {
      if (template.kind === "slot") {
        for (const child of template.fallback ?? []) visit(child);
      } else if (template.kind === "element") {
        if (graph.tags.has(template.name)) children.add(template.name);
        for (const child of template.children) visit(child);
      }
    };
    visit(node.definition.template);
    edges.set(node.definition.contract.tag, children);
  }

  const active = new Set<string>();
  const height = new Map<string, number>();
  const visit = (tag: string): number => {
    if (active.has(tag)) return Infinity;
    const known = height.get(tag);
    if (known !== undefined) return known;
    active.add(tag);
    let result = 1;
    for (const child of edges.get(tag) ?? []) result = Math.max(result, 1 + visit(child));
    active.delete(tag);
    height.set(tag, result);
    return result;
  };
  // An initial root plus 32 nested lowering passes permits 33 component nodes.
  return [...edges.keys()].some((tag) => visit(tag) > 33);
}

export async function convertComponents(options: ConvertOptions): Promise<ConversionManifest> {
  if (options.entries.length === 0) throw new Error("Framework conversion requires at least one component entry.");
  const targetVersion = targetVersions[options.target];
  if (options.targetVersion !== undefined && options.targetVersion !== targetVersion) {
    throw new FrameworkTargetVersionError(options.target, options.targetVersion, targetVersion);
  }
  const projectRoot = resolve(options.root ?? process.cwd());
  const outputRoot = resolve(options.outDirectory);
  const entries = options.entries.map((entry) => pathToFileURL(resolve(projectRoot, entry)).href);
  const seenEntries = new Set<string>();
  for (const entry of entries) {
    if (seenEntries.has(entry)) {
      throw new FrameworkDuplicateEntryError(
        relative(projectRoot, fileURLToPath(entry)).split(sep).join("/"),
      );
    }
    seenEntries.add(entry);
  }
  const graph = await loadNodeComponents(entries, { baseURL: pathToFileURL(`${projectRoot}${sep}`).href });
  const slotsByTag = new Map([...graph.nodes.values()].map((node) => [node.definition.contract.tag, node.definition.slots ?? []] as const));
  const guardNestedDepth = needsNestedDepthGuard(graph);
  const manifestComponents: ConversionManifest["components"][number][] = [];
  const planned: Array<{ artifact: GeneratedArtifact; kind: ConversionOutput["kind"]; source?: string }> = [];
  const claimed = new Map<string, string>();
  const claim = (artifact: GeneratedArtifact, kind: ConversionOutput["kind"], source?: string): void => {
    const previous = claimed.get(artifact.path);
    if (previous !== undefined && previous !== source) {
      throw new FrameworkOutputCollisionError(options.target, artifact.path, [previous, source ?? "<generated>"]);
    }
    claimed.set(artifact.path, source ?? "<generated>");
    planned.push({ artifact, kind, ...(source === undefined ? {} : { source }) });
  };

  for (const node of [...graph.nodes.values()].sort((left, right) => left.url.localeCompare(right.url))) {
    const source = relative(projectRoot, fileURLToPath(node.url)).split(sep).join("/");
    const tag = node.definition.contract.tag;
    // The controller and its relative imports are copied beside the component, which imports them.
    const controllerFiles = new Map<string, GeneratedArtifact>();
    let controller: string | undefined;
    if (node.controller !== undefined) {
      try {
        controller = await addControllerGraph(node.controller.url, node.trustRoot, `${options.target}/controllers/${tag}`, controllerFiles);
      } catch (error) {
        throw new FrameworkConversionError(options.target, source, tag, error instanceof Error ? error.message : String(error));
      }
    }
    const definition = Object.freeze({
      ...node.definition,
      source: Object.freeze({ file: browserDefinitionURL(node.definition, source, options.publicRootURL, options.target, tag) }),
      ...(controller === undefined ? {} : { controller: `./${controller.slice(`${options.target}/`.length)}` }),
    });
    let content: string;
    try {
      content = generateVueComponent(definition, {
        slotsByTag,
        guardNestedDepth,
        ...(node.definition.controller === undefined ? {} : { controllerSpecifier: node.definition.controller }),
      });
    } catch (error) {
      if (error instanceof HtmlDiagnosticError) {
        if (error.diagnostic.code.startsWith("HY")) {
          throw new HtmlDiagnosticError({ ...error.diagnostic, source: error.diagnostic.source ?? node.url });
        }
        throw new FrameworkConversionError(options.target, source, tag, error.message);
      }
      throw error;
    }
    if (/@nextwebwg\//.test(content)) throw new FrameworkConversionError(options.target, source, tag);
    const component: GeneratedArtifact = { path: `${options.target}/${node.definition.contract.name}.vue`, content };
    claim(component, "component", source);
    for (const file of controllerFiles.values()) claim(file, "controller", source);
    manifestComponents.push(Object.freeze({
      name: node.definition.contract.name,
      tag,
      source,
      artifact: component.path,
      ...(controller === undefined ? {} : { controller }),
    }));
  }

  if (planned.some(({ artifact }) => importsVueHost(artifact.content))) {
    claim(vueHostArtifact(), "helper");
  }
  if (planned.some(({ artifact }) => importsVueHtml(artifact.content))) {
    claim(vueHtmlArtifact(), "helper");
  }
  if (planned.some(({ artifact }) => importsVueControl(artifact.content))) {
    claim(vueControlArtifact(), "helper");
  }
  if (planned.some(({ artifact }) => importsVueProps(artifact.content))) {
    claim(vuePropsArtifact(), "helper");
  }

  const conversionEntries = entries.map((url) => {
    const node = graph.nodes.get(url);
    if (node === undefined) throw new Error(`Framework conversion did not resolve entry ${url}.`);
    const component = manifestComponents.find(({ source }) =>
      source === relative(projectRoot, fileURLToPath(node.url)).split(sep).join("/")
    )!;
    return {
      source: component.source,
      tag: component.tag,
      artifact: component.artifact,
    };
  });
  const entry = frameworkEntry(options.mode, options.target, conversionEntries);
  claim(entry, "entry");
  const inventory = "html-next.conversion.json" as const;
  const outputArtifacts: ConversionOutput[] = planned.map(({ artifact, kind, source }) => ({
    path: artifact.path,
    kind,
    ...(source === undefined ? {} : { source }),
  }));
  outputArtifacts.push({ path: inventory, kind: "inventory" });

  const manifest: ConversionManifest = Object.freeze({
    mode: "framework-conversion",
    target: options.target,
    targetVersion,
    graph: options.mode,
    entries: Object.freeze(conversionEntries),
    output: Object.freeze({
      entry: entry.path,
      inventory,
      artifacts: Object.freeze(outputArtifacts),
    }),
    components: Object.freeze(manifestComponents),
  });
  for (const { artifact } of planned) await emit(outputRoot, artifact);
  await mkdir(outputRoot, { recursive: true });
  await writeFile(
    resolve(outputRoot, inventory),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  return manifest;
}
