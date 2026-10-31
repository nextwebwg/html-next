import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { preactArtifact } from "./preact.js";

import {
  addControllerGraph,
  getDiagnosticLocation,
  expandComponentEntries,
  generateVueComponent,
  generateAngularConversion,
  angularArtifacts,
  GENERATOR_VERSION,
  preparedModuleRevision,
  vueBindingsArtifact,
  generateReactConversion,
  generateSvelteConversion,
  HtmlDiagnosticError,
  publishedStates,
  HtmlDiagnosticAggregateError,
  type HtmlDiagnostic,
  loadNodeComponents,
  collectSharedStylesheets,
  compileComponentGraphStylesForConversion,
  wrapStylesheetConditions,
  vueHostArtifact,
  vueHtmlArtifact,
  vueControlArtifact,
  vuePropsArtifact,
  reactPropsArtifact,
  sveltePropsArtifact,
  svelteHtmlArtifact,
  svelteEventsArtifact,
  svelteControlArtifact,
  svelteDataArtifact,
  svelteReactivityArtifact,
  svelteRenderArtifact,
  svelteHostArtifact,
  svelteConnectionArtifact,
  svelteDecorationsArtifact,
  svelteStyleArtifacts,
  reactEventsArtifact,
  reactControlArtifact,
  reactDataArtifact,
  reactHtmlArtifact,
  reactHostArtifact,
  reactContextArtifact,
  reactDepthArtifact,
  reactRenderArtifact,
  requestsHelperArtifact,
  headHelperArtifact,
  type DiagnosticLocation,
  type ComponentGraph,
  type TemplateNode,
  type GeneratedArtifact,
  transitionElements,
  writeHostDeclarations,
} from "@nextwebwg/html-next";

export type FrameworkTarget = "vue" | "react" | "preact" | "svelte" | "angular";
export type ConversionGraph = "application" | "library";

const targetVersions: Readonly<Record<FrameworkTarget, string>> = {
  vue: "3.5",
  react: "19.3",
  preact: "11.1.0",
  svelte: "5.57.1",
  angular: "21.2.24",
};

interface BaseConvertOptions {
  readonly entries: readonly string[];
  readonly target: FrameworkTarget;
  readonly targetVersion?: string;
  readonly outDirectory: string;
  readonly root?: string;
  /** Browser URL of `root`, required when a data source is relative to its component file. */
  readonly publicRootURL?: string;
  /**
   * Publish every state to `<context>` readers, including readers outside this conversion. Without
   * it, a component publishes only the states the converted components read.
   */
  readonly publicState?: boolean;
  /** Also write `<tag>.host.d.ts` beside each definition that declares a controller, as the CLI does. */
  readonly hostTypes?: boolean;
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
  readonly kind: "component" | "controller" | "module" | "helper" | "style" | "entry" | "inventory";
  readonly source?: string;
}

export interface ConversionManifest {
  readonly mode: "framework-conversion";
  readonly target: FrameworkTarget;
  readonly targetVersion: string;
  readonly graph: ConversionGraph;
  /** Package.json fields required by the emitted source artifacts. */
  readonly package: {
    readonly dependencies: Readonly<Record<string, string>>;
    readonly peerDependencies: Readonly<Record<string, string>>;
  };
  readonly entries: readonly ConversionEntry[];
  /** Authored HTML and controller dependencies, relative to the conversion root. */
  readonly sourceFiles: readonly string[];
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
    /** The copied component module with named connection exports, if declared. */
    readonly module?: string;
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
    readonly location?: DiagnosticLocation,
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
    const name = artifact.replace(/\.(?:vue|tsx|svelte|ts)$/, "");
    const path = JSON.stringify(relativeImport(`${target}/index.ts`, entry.artifact));
    return `export { default as ${name} } from ${path};${target === "angular" ? `\nexport * from ${path};` : ""}`;
  });
  return {
    path: `${target}/${mode === "application" ? "application.ts" : "index.ts"}`,
    content: `${exports.join("\n")}\n`,
  };
}

function relativeImport(from: string, to: string): string {
  const path = relative(dirname(from), to).split(sep).join("/");
  return path.startsWith("./") || path.startsWith("../") ? path : `./${path}`;
}

function componentArtifact(projectRoot: string, url: string, tag: string, name: string, target: FrameworkTarget): string {
  const source = relative(projectRoot, fileURLToPath(url));
  const insideRoot = source !== ".." && !source.startsWith(`..${sep}`) && !isAbsolute(source);
  const directory = insideRoot ? dirname(source) : `_external/${tag}`;
  const segments = directory === "." ? [] : directory.split(sep);
  return [target, ...segments, `${name}.${target === "vue" ? "vue" : target === "svelte" ? "svelte" : target === "angular" ? "ts" : "tsx"}`].join("/");
}

function componentRelativeDataSource(source: string): boolean {
  return !source.startsWith("/") && !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(source);
}

function browserDefinitionURL(
  definition: { readonly declarations?: readonly { readonly kind: string; readonly source?: string }[]; readonly scripts?: readonly { readonly src: string }[] },
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
  if (definition.scripts?.some((script) => relativeScript(script.src)) === true && publicRootURL === undefined) {
    throw new FrameworkConversionError(target, source, tag, "a component-relative declared <script src> requires publicRootURL, the browser URL corresponding to the conversion root");
  }
  if (publicRootURL === undefined) return "";
  if (!publicRootURL.endsWith("/") || !/^(?:\/|https?:\/\/)/.test(publicRootURL) || /[?#]/.test(publicRootURL) || source.startsWith("../")) {
    throw new FrameworkConversionError(target, source, tag, "publicRootURL must be an HTTP(S) or root-relative directory URL, and the component must be inside the conversion root");
  }
  return `${publicRootURL}${source.split("/").map(encodeURIComponent).join("/")}`;
}

/** A declared script's `src` relative to its definition, as `./sdk.js` or `../vendor/sdk.js`. */
function relativeScript(src: string): boolean {
  return /^\.\.?\//.test(src);
}

/**
 * The definition's declared scripts with each relative `src` resolved, at build time, against the
 * definition's browser URL, as the live runtime resolves it against the definition's URL.
 */
function browserScripts<T extends { readonly src: string }>(scripts: readonly T[], definitionURL: string): readonly T[];
function browserScripts<T extends { readonly src: string }>(scripts: readonly T[] | undefined, definitionURL: string): readonly T[] | undefined;
function browserScripts<T extends { readonly src: string }>(scripts: readonly T[] | undefined, definitionURL: string): readonly T[] | undefined {
  if (scripts === undefined || !scripts.some((script) => relativeScript(script.src))) return scripts;
  const base = new URL(definitionURL, "https://html-next.invalid/");
  return Object.freeze(scripts.map((script) => {
    if (!relativeScript(script.src)) return script;
    const resolved = new URL(script.src, base);
    return Object.freeze({ ...script, src: resolved.origin === base.origin && !/^https?:/.test(definitionURL) ? `${resolved.pathname}${resolved.search}${resolved.hash}` : resolved.href });
  }));
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

function decoratedRoots(graph: ComponentGraph): Map<string, { classes: boolean; styles: boolean }> {
  const receivers = new Map<string, { classes: boolean; styles: boolean }>();
  const pending: string[] = [];
  const add = (tag: string, classes: boolean, styles: boolean): boolean => {
    const previous = receivers.get(tag);
    if ((!classes || previous?.classes) && (!styles || previous?.styles)) return false;
    receivers.set(tag, { classes: classes || previous?.classes === true, styles: styles || previous?.styles === true });
    pending.push(tag);
    return true;
  };
  for (const node of graph.nodes.values()) {
    const visit = (template: TemplateNode): void => {
      if (template.kind === "slot") for (const child of template.fallback ?? []) visit(child);
      else if (template.kind === "element") {
        if (template.name.includes("-")) add(template.name,
          template.attributes.some((attribute) => attribute.kind === "attribute" && attribute.target === "class"),
          template.attributes.some((attribute) => attribute.kind === "attribute" && attribute.target === "style"));
        for (const child of template.children) visit(child);
      }
    };
    visit(node.definition.template);
  }
  while (pending.length > 0) {
    const tag = pending.pop()!;
    const id = graph.tags.get(tag);
    const root = id === undefined ? undefined : graph.nodes.get(id)?.definition.root;
    if (root?.kind === "component") {
      const receiver = receivers.get(tag)!;
      add(root.tag, receiver.classes, receiver.styles);
    }
  }
  return receivers;
}

function nativeBindingRoots(graph: ComponentGraph): Map<string, Set<string>> {
  const receivers = new Map<string, Set<string>>();
  const pending: string[] = [];
  const add = (tag: string, name: string): void => {
    let names = receivers.get(tag);
    if (names?.has(name)) return;
    if (names === undefined) receivers.set(tag, names = new Set());
    names.add(name);
    pending.push(tag);
  };
  for (const node of graph.nodes.values()) {
    const visit = (template: TemplateNode): void => {
      if (template.kind === "slot") for (const child of template.fallback ?? []) visit(child);
      else if (template.kind === "element") {
        const id = graph.tags.get(template.name);
        const props = id === undefined ? undefined : graph.nodes.get(id)?.definition.contract.props;
        if (props !== undefined) for (const attribute of template.attributes) {
          if (attribute.kind === "attribute" && attribute.twoWay === true && !Object.keys(props).some((name) => name.toLowerCase() === attribute.name || name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase() === attribute.name)) add(template.name, attribute.name);
        }
        for (const child of template.children) visit(child);
      }
    };
    visit(node.definition.template);
  }
  while (pending.length > 0) {
    const tag = pending.pop()!;
    const id = graph.tags.get(tag);
    const root = id === undefined ? undefined : graph.nodes.get(id)?.definition.root;
    if (root?.kind === "component") for (const name of receivers.get(tag)!) add(root.tag, name);
  }
  return receivers;
}

export type CheckConversionOptions = Omit<ConvertOptions, "outDirectory"> & {
  /** Receives non-fatal diagnostics, such as `HT022`, from a check that otherwise succeeds. */
  readonly onWarning?: (diagnostic: HtmlDiagnostic) => void;
};

/** Runs the conversion planner and backend checks without writing artifacts. */
export async function checkConversion(options: CheckConversionOptions): Promise<ConversionManifest> {
  return (await planConversion(options, true)).manifest;
}

export async function convertComponents(options: ConvertOptions): Promise<ConversionManifest> {
  const { manifest, artifacts, graph } = await planConversion(options);
  if (options.hostTypes === true) await writeHostDeclarations(graph);
  const outputRoot = resolve(options.outDirectory);
  for (const artifact of artifacts) await emit(outputRoot, artifact);
  await mkdir(outputRoot, { recursive: true });
  await writeFile(resolve(outputRoot, manifest.output.inventory), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}

async function planConversion(options: CheckConversionOptions, collectDiagnostics = false): Promise<{
  readonly manifest: ConversionManifest;
  readonly artifacts: readonly GeneratedArtifact[];
  readonly graph: ComponentGraph;
}> {
  const diagnostics: HtmlDiagnostic[] = [];
  const recover = (error: unknown): void => {
    if (!collectDiagnostics) throw error;
    if (error instanceof HtmlDiagnosticError) diagnostics.push(error.diagnostic);
    else if (error instanceof FrameworkConversionError) diagnostics.push({ code: error.code, message: error.message, source: error.source, ...error.location });
    else if (error instanceof FrameworkOutputCollisionError) diagnostics.push({ code: error.code, message: error.message, source: error.sources[1] });
    else throw error;
  };
  if (options.entries.length === 0) throw new Error("Framework conversion requires at least one component entry.");
  const targetVersion = targetVersions[options.target];
  if (options.targetVersion !== undefined && options.targetVersion !== targetVersion) {
    throw new FrameworkTargetVersionError(options.target, options.targetVersion, targetVersion);
  }
  const reactTarget = options.target === "react" || options.target === "preact";
  const projectRoot = resolve(options.root ?? process.cwd());
  const expanded = await expandComponentEntries(projectRoot, options.entries);
  const entries = expanded.map((entry) => pathToFileURL(resolve(projectRoot, entry)).href);
  const seenEntries = new Set<string>();
  for (const entry of entries) {
    if (seenEntries.has(entry)) {
      throw new FrameworkDuplicateEntryError(
        relative(projectRoot, fileURLToPath(entry)).split(sep).join("/"),
      );
    }
    seenEntries.add(entry);
  }
  const graph = await loadNodeComponents(entries, { baseURL: pathToFileURL(`${projectRoot}${sep}`).href, collectDiagnostics });
  // Only the native Vite build builds the `transitions` extension; conversion leaves its directives out.
  const unsupported: HtmlDiagnostic[] = [...graph.nodes.values()].flatMap(({ definition }) => {
    const [first] = transitionElements(definition);
    if (first === undefined) return [];
    return [{
      code: "HT024", severity: "warning" as const, source: definition.source.file,
      message: `\`$transition\` and \`$transition-name\` use the \`transitions\` extension, which ${options.target} conversion does not support; \`${definition.contract.tag}\` converts without animation.`,
      ...first.line === undefined || first.column === undefined ? {} : { line: first.line, column: first.column },
    }];
  });
  const sourceFiles = new Set([...graph.nodes.values()].map((node) => fileURLToPath(node.url)).concat(graph.stylesheetInputs.map(url => fileURLToPath(url))));
  const sharedStyles = collectSharedStylesheets([...graph.nodes.values()].map(node => node.definition));
  const sharedStylePath = `${options.target}/shared-components.css`;
  const pathsByTag = new Map([...graph.nodes.values()].map((node) => [
    node.definition.contract.tag,
    componentArtifact(projectRoot, node.url, node.definition.contract.tag, node.definition.contract.name, options.target),
  ] as const));
  const names = new Map<string, { readonly path: string; readonly source: string }>();
  for (const node of graph.nodes.values()) {
    try {
      const name = node.definition.contract.name;
      const path = pathsByTag.get(node.definition.contract.tag)!;
      const source = relative(projectRoot, fileURLToPath(node.url)).split(sep).join("/");
      const prior = names.get(name);
      if (prior !== undefined && prior.path !== path) {
        throw new FrameworkOutputCollisionError(options.target, `${options.target}/index.ts`, [prior.source, source]);
      }
      names.set(name, { path, source });
    } catch (error) { recover(error); }
  }
  const definitions = [...graph.nodes.values()].map((node) => node.definition);
  const slotsByTag = new Map([...graph.nodes.values()].map((node) => [node.definition.contract.tag, node.definition.slots ?? []] as const));
  // Another component's `:state()` tests resolve against the whole graph, and each root carries the states they test on it.
  const componentGraph = new Map([...graph.nodes.values()].map((node) => [node.definition.contract.tag, node.definition] as const));
  const propsByTag = new Map([...graph.nodes.values()].map((node) => [node.definition.contract.tag,
    new Set(Object.keys(node.definition.contract.props))] as const));
  const propContractsByTag = new Map([...graph.nodes.values()].map((node) => [node.definition.contract.tag,
    node.definition.contract.props] as const));
  const guardNestedDepth = needsNestedDepthGuard(graph);
  const bindingReceivers = options.target === "svelte" ? nativeBindingRoots(graph) : undefined;
  const decorationReceivers = options.target === "svelte" ? decoratedRoots(graph) : undefined;
  const manifestComponents: ConversionManifest["components"][number][] = [];
  const planned: Array<{ artifact: GeneratedArtifact; kind: ConversionOutput["kind"]; source?: string }> = [];
  const neededHelpers = new Set<string>();
  const hasDeclaredEvents = [...graph.nodes.values()].some((node) =>
    node.definition.declarations?.some((declaration) => declaration.kind === "event") === true);
  let reactStyles = false;
  const claimed = new Map<string, string>();
  const claim = (inputArtifact: GeneratedArtifact, kind: ConversionOutput["kind"], source?: string): void => {
    const artifact = options.target === "preact" && (kind === "component" || kind === "helper") ? preactArtifact(inputArtifact) : inputArtifact;
    const previous = claimed.get(artifact.path);
    if (previous !== undefined && previous !== source) {
      throw new FrameworkOutputCollisionError(options.target, artifact.path, [previous, source ?? "<generated>"]);
    }
    claimed.set(artifact.path, source ?? "<generated>");
    planned.push({ artifact, kind, ...(source === undefined ? {} : { source }) });
  };

  const controllerRoots = new Map([...new Set([...graph.nodes.values()].map(node => node.trustRoot))].sort()
    .map((root, index) => [root, `${options.target}/modules/${index}`]));
  const emittedControllerFiles = new Map<string, string>();
  for (const node of [...graph.nodes.values()].sort((left, right) => left.url.localeCompare(right.url))) {
    try {
      const source = relative(projectRoot, fileURLToPath(node.url)).split(sep).join("/");
      const tag = node.definition.contract.tag;
      const componentPath = pathsByTag.get(tag)!;
      // Preserve each package's module graph once, including imports shared by separate components.
      const controllerFiles = new Map<string, GeneratedArtifact>();
      let controller: string | undefined;
      const edge = node.module ?? node.controller;
      if (edge !== undefined) {
        try {
          controller = await addControllerGraph(edge.url, node.trustRoot, controllerRoots.get(node.trustRoot)!, controllerFiles, sourceFiles, { relativeToTrustRoot: true });
        } catch (error) {
          throw new FrameworkConversionError(options.target, source, tag, error instanceof Error ? error.message : String(error), getDiagnosticLocation(node.definition));
        }
      }
      const modulePreparation = options.target !== "vue" || node.module === undefined || controller === undefined ? undefined
        : await preparedModuleRevision(controller, node.definition, GENERATOR_VERSION, async path => {
          const artifact = controllerFiles.get(path);
          if (artifact === undefined) throw new Error(`Missing prepared module dependency: ${path}.`);
          return artifact.content;
        });
      const definitionURL = browserDefinitionURL(node.definition, source, options.publicRootURL, options.target, tag);
      const scripts = browserScripts(node.definition.scripts, definitionURL);
      const definition = Object.freeze({
        ...node.definition,
        ...(scripts === undefined || scripts === node.definition.scripts ? {} : {
          scripts,
          contract: Object.freeze({ ...node.definition.contract, scripts: browserScripts(node.definition.contract.scripts!, definitionURL) }),
        }),
        ...(!reactTarget && options.target !== "angular" && node.definition.stylesheets !== undefined ? {
          css: node.definition.stylesheets.map(sheet => wrapStylesheetConditions(sheet.css, sheet.conditions)).join("\n") + "\n" + node.definition.css,
          stylesheets: [],
        } : {}),
        source: Object.freeze({ file: definitionURL }),
        ...(controller === undefined ? {} : { [node.module === undefined ? "controller" : "module"]: relativeImport(componentPath, controller) }),
      });
      // A state is published only for the readers the build knows of, unless every state is public.
      const published = options.publicState === true ? undefined : publishedStates(node.definition, definitions);
      let content: string;
      let reactConversion: ReturnType<typeof generateReactConversion> | undefined;
      let angularConversion: ReturnType<typeof generateAngularConversion> | undefined;
      let svelteConversion: ReturnType<typeof generateSvelteConversion> | undefined;
      const helpers = new Set<string>();
      try {
        const importSpecifier = (importedTag: string): string => {
          const imported = pathsByTag.get(importedTag);
          if (imported === undefined) throw new FrameworkConversionError(options.target, source, tag, `unknown component <${importedTag}>`);
          return relativeImport(componentPath, imported);
        };
        const reactHelperSpecifier = (name: string): string => relativeImport(componentPath, `${options.target}/${name}.ts`).replace(/\.ts$/, "");
        content = options.target === "angular" ? (angularConversion = generateAngularConversion(definition, GENERATOR_VERSION, {
          componentGraph, importSpecifier,
          controllerSpecifier: importedTag => {
            const importedNode = graph.nodes.get(graph.tags.get(importedTag)!)!;
            const edge = importedNode.module ?? importedNode.controller;
            return edge === undefined ? undefined : relativeImport(componentPath, `${controllerRoots.get(importedNode.trustRoot)!}/${relative(fileURLToPath(importedNode.trustRoot), fileURLToPath(edge.url)).split(sep).join("/")}`);
          },
          definitionURL: importedTag => {
            const imported = graph.nodes.get(graph.tags.get(importedTag)!)!;
            return browserDefinitionURL(imported.definition, relative(projectRoot, fileURLToPath(imported.url)), options.publicRootURL, "angular", importedTag);
          },
          ...(options.publicState === true ? { publicState: true } : {}),
          helperSpecifier: name => relativeImport(componentPath, `angular/${name}.ts`).replace(/\.ts$/, ""),
        })).component : options.target === "vue" ? generateVueComponent(definition, {
          ...(modulePreparation === undefined ? {} : { modulePreparation }),
          publishedStates: published,
          slotsByTag,
          componentGraph,
          propContractsByTag,
          guardNestedDepth,
          importSpecifier,
          helperSpecifier: (name) => {
            helpers.add(name);
            return relativeImport(componentPath, `${options.target}/${name}.ts`).replace(/\.ts$/, "");
          },
          ...((node.definition.module ?? node.definition.controller) === undefined ? {} : { controllerSpecifier: node.definition.module ?? node.definition.controller }),
        }) : options.target === "svelte" ? (svelteConversion = generateSvelteConversion(definition, {
          publishedStates: published,
          slotsByTag,
          componentGraph,
          guardNestedDepth,
          rootDecorations: decorationReceivers?.get(tag),
          ...(bindingReceivers?.has(tag) === true ? { rootBindings: [...bindingReceivers.get(tag)!] } : {}),
          decorationsSpecifier: relativeImport(componentPath, "svelte/decorations.ts").replace(/\.ts$/, ""),
          styleSpecifier: relativeImport(componentPath, "svelte/style/style.js"),
          hostSpecifier: relativeImport(componentPath, "svelte/host.svelte.ts").replace(/\.ts$/, ""),
          connectionSpecifier: relativeImport(componentPath, "svelte/connection.svelte.ts").replace(/\.ts$/, ""),
          ...((node.definition.module ?? node.definition.controller) === undefined ? {} : { controllerSpecifier: node.definition.module ?? node.definition.controller }),
          reactivitySpecifier: relativeImport(componentPath, "svelte/reactivity.svelte.ts").replace(/\.ts$/, ""),
          renderSpecifier: relativeImport(componentPath, "svelte/render.svelte.ts").replace(/\.ts$/, ""),
          importSpecifier,
          propContractsByTag,
          propsSpecifier: relativeImport(componentPath, "svelte/props.ts").replace(/\.ts$/, ""),
          htmlSpecifier: relativeImport(componentPath, "svelte/html.ts").replace(/\.ts$/, ""),
          eventsSpecifier: relativeImport(componentPath, "svelte/events.ts").replace(/\.ts$/, ""),
          controlSpecifier: relativeImport(componentPath, "svelte/control.ts").replace(/\.ts$/, ""),
          dataSpecifier: relativeImport(componentPath, "svelte/data.svelte.ts").replace(/\.ts$/, ""),
          requestsSpecifier: relativeImport(componentPath, "svelte/requests.ts").replace(/\.ts$/, ""),
          headSpecifier: relativeImport(componentPath, "svelte/head.svelte.ts").replace(/\.ts$/, ""),
        })).component : (reactConversion = generateReactConversion(definition, {
          target: options.target,
          publishedStates: published,
          slotsByTag,
          componentGraph,
          propsByTag,
          propContractsByTag,
          guardNestedDepth,
          importSpecifier,
          propsSpecifier: reactHelperSpecifier("props"),
          eventsSpecifier: reactHelperSpecifier("events"),
          controlSpecifier: reactHelperSpecifier("control"),
          dataSpecifier: reactHelperSpecifier("data"),
          htmlSpecifier: reactHelperSpecifier("html"),
          hostSpecifier: reactHelperSpecifier("host"),
          contextSpecifier: reactHelperSpecifier("context"),
          depthSpecifier: reactHelperSpecifier("depth"),
          renderSpecifier: reactHelperSpecifier("render"),
          requestsSpecifier: reactHelperSpecifier("requests"),
          headSpecifier: reactHelperSpecifier("head"),
          ...((node.definition.module ?? node.definition.controller) === undefined ? {} : { controllerSpecifier: node.definition.module ?? node.definition.controller }),
        })).component;
      } catch (error) {
        if (error instanceof HtmlDiagnosticError) {
          if (error.diagnostic.code.startsWith("HY")) {
            throw new HtmlDiagnosticError({ ...error.diagnostic, source: error.diagnostic.source ?? node.url });
          }
          throw new FrameworkConversionError(options.target, source, tag, error.message, error.diagnostic.line === undefined ? getDiagnosticLocation(node.definition) : { line: error.diagnostic.line, column: error.diagnostic.column! });
        }
        throw error;
      }
      if (/@nextwebwg\//.test(content)) throw new FrameworkConversionError(options.target, source, tag);
      if (sharedStyles.length > 0 && reactTarget) {
        content = content.replace(/^import ["'][^"']+\.css["'];?\s*$/gm, "");
        content = `import ${JSON.stringify(relativeImport(componentPath, sharedStylePath))};\n${content}`;
        reactStyles = true;
      }
      // TypeScript 6+ rejects a stylesheet import unless the program declares `*.css`.
      const component: GeneratedArtifact = reactConversion !== undefined && (reactConversion.css !== "" || sharedStyles.length > 0)
        ? { path: componentPath, content: `/// <reference path="${posix.relative(posix.dirname(componentPath), `${options.target}/styles.d.ts`)}" />\n${content}` }
        : { path: componentPath, content };
      claim(component, "component", source);
      if (angularConversion !== undefined) for (const name of angularConversion.helpers) neededHelpers.add(name);
      if (reactConversion !== undefined) {
        for (const helper of reactConversion.helpers) neededHelpers.add(helper);
        const css = reactConversion.css;
        if (css !== "" && sharedStyles.length === 0) {
          reactStyles = true;
          claim({ path: componentPath.replace(/\.tsx$/, ".css"), content: `${css}\n` }, "style", source);
        }
      }
      if (svelteConversion !== undefined) for (const helper of svelteConversion.helpers) neededHelpers.add(helper);
      for (const helper of helpers) neededHelpers.add(helper);
      for (const file of controllerFiles.values()) {
        const previous = emittedControllerFiles.get(file.path);
        if (previous !== undefined) {
          if (previous !== file.content) throw new FrameworkOutputCollisionError(options.target, file.path, [file.path, source]);
          continue;
        }
        emittedControllerFiles.set(file.path, file.content);
        claim(file, node.module === undefined ? "controller" : "module", source);
        if (/\.(?:js|mjs|cjs)$/.test(file.path)) {
          const declarationPath = file.path.replace(/\.mjs$/, ".d.mts").replace(/\.cjs$/, ".d.cts").replace(/\.js$/, ".d.ts");
          if (!controllerFiles.has(declarationPath)) claim({ path: declarationPath, content: node.module === undefined
            ? "declare const controller: unknown;\nexport default controller;\n"
            : "export declare const connect: unknown;\n" }, "helper", source);
        }
      }
      manifestComponents.push(Object.freeze({
        name: node.definition.contract.name,
        tag,
        source,
        artifact: component.path,
        ...(controller === undefined ? {} : { [node.module === undefined ? "controller" : "module"]: controller }),
      }));
    } catch (error) { recover(error); }
  }
  if (diagnostics.length > 0) throw new HtmlDiagnosticAggregateError([...graph.warnings ?? [], ...unsupported, ...diagnostics]);

  if (options.target === "angular") for (const artifact of angularArtifacts(GENERATOR_VERSION, neededHelpers)) claim(artifact, "helper");
  if (options.target === "vue" && neededHelpers.has("bindings")) claim(vueBindingsArtifact(), "helper");
  if (options.target === "vue" && neededHelpers.has("host")) {
    claim(vueHostArtifact(), "helper");
  }
  if (options.target === "vue" && neededHelpers.has("html")) {
    claim(vueHtmlArtifact(), "helper");
  }
  if (options.target === "vue" && neededHelpers.has("control")) {
    claim(vueControlArtifact(), "helper");
  }
  if (options.target === "vue" && neededHelpers.has("props")) {
    claim(vuePropsArtifact(), "helper");
  }
  if (reactTarget && neededHelpers.has("props")) {
    claim(reactPropsArtifact(), "helper");
  }
  if (options.target === "svelte" && neededHelpers.has("props")) {
    claim(sveltePropsArtifact(), "helper");
  }
  if (options.target === "svelte" && neededHelpers.has("html")) {
    claim(svelteHtmlArtifact(), "helper");
  }
  if (options.target === "svelte" && neededHelpers.has("control")) {
    claim(svelteControlArtifact(), "helper");
  }
  if (options.target === "svelte" && neededHelpers.has("decorations")) {
    claim(svelteDecorationsArtifact(), "helper");
  }
  if (options.target === "svelte" && neededHelpers.has("style")) {
    for (const artifact of svelteStyleArtifacts()) claim(artifact, "helper");
  }
  if (options.target === "svelte" && neededHelpers.has("connection")) {
    claim(svelteConnectionArtifact(), "helper");
  }
  if (options.target === "svelte" && neededHelpers.has("host")) {
    claim(svelteHostArtifact(), "helper");
  }
  if (options.target === "svelte" && neededHelpers.has("reactivity")) {
    claim(svelteReactivityArtifact(), "helper");
  }
  if (options.target === "svelte" && neededHelpers.has("render")) {
    claim(svelteRenderArtifact(), "helper");
  }
  if (options.target === "svelte" && neededHelpers.has("data")) {
    claim(svelteDataArtifact(), "helper");
  }
  if (options.target === "svelte" && neededHelpers.has("events")) {
    claim(svelteEventsArtifact(hasDeclaredEvents), "helper");
  }
  if (reactTarget && neededHelpers.has("events")) {
    claim(reactEventsArtifact(hasDeclaredEvents), "helper");
  }
  if (reactTarget && neededHelpers.has("control")) {
    claim(reactControlArtifact(), "helper");
  }
  if (reactTarget && neededHelpers.has("data")) {
    claim(reactDataArtifact(), "helper");
  }
  if (reactTarget && neededHelpers.has("html")) {
    claim(reactHtmlArtifact(), "helper");
  }
  if (reactTarget && neededHelpers.has("host")) {
    claim(reactHostArtifact(), "helper");
  }
  if (reactTarget && neededHelpers.has("context")) {
    claim(reactContextArtifact(), "helper");
  }
  if (reactTarget && neededHelpers.has("depth")) {
    claim(reactDepthArtifact(), "helper");
  }
  if (reactTarget && neededHelpers.has("render")) {
    claim(reactRenderArtifact(options.target === "preact" ? "preact" : "react"), "helper");
  }
  if (options.target !== "angular" && neededHelpers.has("requests")) claim(requestsHelperArtifact(options.target === "preact" ? "react" : options.target), "helper");
  if (options.target !== "angular" && neededHelpers.has("head")) claim(headHelperArtifact(options.target === "preact" ? "react" : options.target), "helper");
  if (reactTarget && reactStyles) {
    claim({ path: `${options.target}/styles.d.ts`, content: 'declare module "*.css";\n' }, "helper");
  }
  if (sharedStyles.length > 0 && reactTarget) {
    const css = compileComponentGraphStylesForConversion([...graph.nodes.values()].map(node => node.definition));
    claim({ path: sharedStylePath, content: wrapStylesheetConditions(css, []) + "\n" }, "style");
  }

  const conversionEntries = graph.roots.map((id) => {
    const node = graph.nodes.get(id);
    if (node === undefined) throw new Error(`Framework conversion did not resolve entry ${id}.`);
    const component = manifestComponents.find(({ tag }) => tag === node.definition.contract.tag)!;
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
    package: Object.freeze({
      dependencies: Object.freeze({ ...(neededHelpers.has("html") ? { parse5: "^8.0.1" } : {}), ...(options.target === "svelte" && neededHelpers.has("style") ? { cssstyle: "^6.2.0", "css-tree": "^3.2.1" } : {}) }),
      // Vue 3.5.43 restores generic inference through runtime PropType declarations.
      peerDependencies: Object.freeze(options.target === "angular" ? { "@angular/core": ">=21.2.24", ...(neededHelpers.has("slots") ? { "@angular/common": ">=21.2.24" } : {}) } : { [options.target]: options.target === "vue" ? "^3.5.43" : options.target === "preact" ? `^${targetVersion}` : `^${targetVersion}${options.target === "svelte" ? "" : ".0"}` }),
    }),
    entries: Object.freeze(conversionEntries),
    sourceFiles: Object.freeze([...sourceFiles].map((path) => relative(projectRoot, path).split(sep).join("/")).sort()),
    output: Object.freeze({
      entry: entry.path,
      inventory,
      artifacts: Object.freeze(outputArtifacts),
    }),
    components: Object.freeze(manifestComponents),
  });
  for (const warning of [...graph.warnings ?? [], ...unsupported]) options.onWarning?.(warning);
  return { manifest, artifacts: planned.map(({ artifact }) => artifact), graph };
}
