import { glob, lstat, mkdir, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  addControllerGraph,
  generateVueComponent,
  generateReactConversion,
  generateSvelteConversion,
  HtmlDiagnosticError,
  loadNodeComponents,
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
  svelteHostArtifact,
  reactEventsArtifact,
  reactControlArtifact,
  reactDataArtifact,
  reactHtmlArtifact,
  reactHostArtifact,
  reactContextArtifact,
  reactDepthArtifact,
  type ComponentGraph,
  type TemplateNode,
  type GeneratedArtifact,
} from "@nextwebwg/html-next";

export type FrameworkTarget = "vue" | "react" | "svelte";
export type ConversionGraph = "application" | "library";

const targetVersions: Readonly<Record<FrameworkTarget, string>> = {
  vue: "3.5",
  react: "19.3",
  svelte: "5.57.1",
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
  readonly kind: "component" | "controller" | "helper" | "style" | "entry" | "inventory";
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
    const name = artifact.replace(/\.(?:vue|tsx|svelte)$/, "");
    return `export { default as ${name} } from ${JSON.stringify(relativeImport(`${target}/index.ts`, entry.artifact))};`;
  });
  return {
    path: `${target}/${mode === "application" ? "application.ts" : "index.ts"}`,
    content: `${exports.join("\n")}\n`,
  };
}

function relativeImport(from: string, to: string): string {
  const path = relative(dirname(from), to).split(sep).join("/");
  return path.startsWith(".") ? path : `./${path}`;
}

function hasGlob(pattern: string): boolean {
  return pattern.includes("*") || pattern.includes("?") || pattern.includes("[") || pattern.includes("{");
}

/** A file remains an entry; a glob or directory expands to every HTML component below it. */
async function expandEntries(projectRoot: string, patterns: readonly string[]): Promise<string[]> {
  const entries: string[] = [];
  for (const pattern of patterns) {
    let scan = pattern;
    if (!hasGlob(pattern)) {
      const path = resolve(projectRoot, pattern);
      const metadata = await lstat(path).catch((error: unknown) => {
        if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined;
        throw error;
      });
      if (!metadata?.isDirectory()) {
        entries.push(pattern);
        continue;
      }
      scan = `${pattern.replace(/[\\/]$/, "")}/**`;
    }
    const matches: string[] = [];
    for await (const match of glob(scan, { cwd: projectRoot })) {
      if (extname(match).toLowerCase() !== ".html") continue;
      if (!(await lstat(resolve(projectRoot, match))).isFile()) continue;
      matches.push(match);
    }
    if (matches.length === 0) throw new Error(`Framework conversion input ${JSON.stringify(pattern)} matched no HTML component files.`);
    entries.push(...matches.sort());
  }
  return entries;
}

function componentArtifact(projectRoot: string, url: string, tag: string, name: string, target: FrameworkTarget): string {
  const source = relative(projectRoot, fileURLToPath(url));
  const insideRoot = source !== ".." && !source.startsWith(`..${sep}`) && !isAbsolute(source);
  const directory = insideRoot ? dirname(source) : `_external/${tag}`;
  const segments = directory === "." ? [] : directory.split(sep);
  return [target, ...segments, `${name}.${target === "vue" ? "vue" : target === "svelte" ? "svelte" : "tsx"}`].join("/");
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
  const expanded = await expandEntries(projectRoot, options.entries);
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
  const graph = await loadNodeComponents(entries, { baseURL: pathToFileURL(`${projectRoot}${sep}`).href });
  const sourceFiles = new Set([...graph.nodes.values()].map((node) => fileURLToPath(node.url)));
  const pathsByTag = new Map([...graph.nodes.values()].map((node) => [
    node.definition.contract.tag,
    componentArtifact(projectRoot, node.url, node.definition.contract.tag, node.definition.contract.name, options.target),
  ] as const));
  const names = new Map<string, { readonly path: string; readonly source: string }>();
  for (const node of graph.nodes.values()) {
    const name = node.definition.contract.name;
    const path = pathsByTag.get(node.definition.contract.tag)!;
    const source = relative(projectRoot, fileURLToPath(node.url)).split(sep).join("/");
    const prior = names.get(name);
    if (prior !== undefined && prior.path !== path) {
      throw new FrameworkOutputCollisionError(options.target, `${options.target}/index.ts`, [prior.source, source]);
    }
    names.set(name, { path, source });
  }
  const slotsByTag = new Map([...graph.nodes.values()].map((node) => [node.definition.contract.tag, node.definition.slots ?? []] as const));
  const propsByTag = new Map([...graph.nodes.values()].map((node) => [node.definition.contract.tag,
    new Set(Object.keys(node.definition.contract.props))] as const));
  const propContractsByTag = new Map([...graph.nodes.values()].map((node) => [node.definition.contract.tag,
    node.definition.contract.props] as const));
  const guardNestedDepth = needsNestedDepthGuard(graph);
  const manifestComponents: ConversionManifest["components"][number][] = [];
  const planned: Array<{ artifact: GeneratedArtifact; kind: ConversionOutput["kind"]; source?: string }> = [];
  const neededHelpers = new Set<string>();
  const hasDeclaredEvents = [...graph.nodes.values()].some((node) =>
    node.definition.declarations?.some((declaration) => declaration.kind === "event") === true);
  let reactStyles = false;
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
    const componentPath = pathsByTag.get(tag)!;
    // The controller and its relative imports are copied beside the component, which imports them.
    const controllerFiles = new Map<string, GeneratedArtifact>();
    let controller: string | undefined;
    if (node.controller !== undefined) {
      try {
        controller = await addControllerGraph(node.controller.url, node.trustRoot, `${options.target}/controllers/${tag}`, controllerFiles, sourceFiles);
      } catch (error) {
        throw new FrameworkConversionError(options.target, source, tag, error instanceof Error ? error.message : String(error));
      }
    }
    const definition = Object.freeze({
      ...node.definition,
      source: Object.freeze({ file: browserDefinitionURL(node.definition, source, options.publicRootURL, options.target, tag) }),
      ...(controller === undefined ? {} : { controller: relativeImport(componentPath, controller) }),
    });
    let content: string;
    let reactConversion: ReturnType<typeof generateReactConversion> | undefined;
    let svelteConversion: ReturnType<typeof generateSvelteConversion> | undefined;
    const helpers = new Set<string>();
    try {
      const importSpecifier = (importedTag: string): string => {
        const imported = pathsByTag.get(importedTag);
        if (imported === undefined) throw new FrameworkConversionError(options.target, source, tag, `unknown component <${importedTag}>`);
        return relativeImport(componentPath, imported);
      };
      const reactHelperSpecifier = (name: string): string => relativeImport(componentPath, `react/${name}.ts`).replace(/\.ts$/, "");
      content = options.target === "vue" ? generateVueComponent(definition, {
        slotsByTag,
        guardNestedDepth,
        importSpecifier,
        helperSpecifier: (name) => {
          helpers.add(name);
          return relativeImport(componentPath, `${options.target}/${name}.ts`).replace(/\.ts$/, "");
        },
        ...(node.definition.controller === undefined ? {} : { controllerSpecifier: node.definition.controller }),
      }) : options.target === "svelte" ? (svelteConversion = generateSvelteConversion(definition, {
        slotsByTag,
        guardNestedDepth,
        hostSpecifier: relativeImport(componentPath, "svelte/host.svelte.ts").replace(/\.ts$/, ""),
        ...(node.definition.controller === undefined ? {} : { controllerSpecifier: node.definition.controller }),
        reactivitySpecifier: relativeImport(componentPath, "svelte/reactivity.svelte.ts").replace(/\.ts$/, ""),
        importSpecifier,
        propContractsByTag,
        stylesheetSpecifier: `./${node.definition.contract.name}.css`,
        propsSpecifier: relativeImport(componentPath, "svelte/props.ts").replace(/\.ts$/, ""),
        htmlSpecifier: relativeImport(componentPath, "svelte/html.ts").replace(/\.ts$/, ""),
        eventsSpecifier: relativeImport(componentPath, "svelte/events.ts").replace(/\.ts$/, ""),
        controlSpecifier: relativeImport(componentPath, "svelte/control.ts").replace(/\.ts$/, ""),
        dataSpecifier: relativeImport(componentPath, "svelte/data.svelte.ts").replace(/\.ts$/, ""),
      })).component : (reactConversion = generateReactConversion(definition, {
        slotsByTag,
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
        ...(node.definition.controller === undefined ? {} : { controllerSpecifier: node.definition.controller }),
      })).component;
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
    const component: GeneratedArtifact = { path: componentPath, content };
    claim(component, "component", source);
    if (reactConversion !== undefined) {
      for (const helper of reactConversion.helpers) neededHelpers.add(helper);
      const css = reactConversion.css;
      if (css !== "") {
        reactStyles = true;
        claim({ path: componentPath.replace(/\.tsx$/, ".css"), content: `${css}\n` }, "style", source);
      }
    }
    if (svelteConversion !== undefined && svelteConversion.css !== "") {
      claim({ path: componentPath.replace(/\.svelte$/, ".css"), content: `${svelteConversion.css}\n` }, "style", source);
    }
    if (svelteConversion !== undefined) for (const helper of svelteConversion.helpers) neededHelpers.add(helper);
    for (const helper of helpers) neededHelpers.add(helper);
    for (const file of controllerFiles.values()) {
      claim(file, "controller", source);
      if (options.target === "react" && /\.(?:js|mjs|cjs)$/.test(file.path)) {
        const declarationPath = file.path.replace(/\.mjs$/, ".d.mts").replace(/\.cjs$/, ".d.cts").replace(/\.js$/, ".d.ts");
        claim({ path: declarationPath, content: "declare const controller: unknown;\nexport default controller;\n" }, "helper", source);
      }
    }
    manifestComponents.push(Object.freeze({
      name: node.definition.contract.name,
      tag,
      source,
      artifact: component.path,
      ...(controller === undefined ? {} : { controller }),
    }));
  }

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
  if (options.target === "react" && neededHelpers.has("props")) {
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
  if (options.target === "svelte" && neededHelpers.has("host")) {
    claim(svelteHostArtifact(), "helper");
  }
  if (options.target === "svelte" && neededHelpers.has("reactivity")) {
    claim(svelteReactivityArtifact(), "helper");
  }
  if (options.target === "svelte" && neededHelpers.has("data")) {
    claim(svelteDataArtifact(), "helper");
  }
  if (options.target === "svelte" && neededHelpers.has("events")) {
    claim(svelteEventsArtifact(hasDeclaredEvents), "helper");
  }
  if (options.target === "react" && neededHelpers.has("events")) {
    claim(reactEventsArtifact(hasDeclaredEvents), "helper");
  }
  if (options.target === "react" && neededHelpers.has("control")) {
    claim(reactControlArtifact(), "helper");
  }
  if (options.target === "react" && neededHelpers.has("data")) {
    claim(reactDataArtifact(), "helper");
  }
  if (options.target === "react" && neededHelpers.has("html")) {
    claim(reactHtmlArtifact(), "helper");
  }
  if (options.target === "react" && neededHelpers.has("host")) {
    claim(reactHostArtifact(), "helper");
  }
  if (options.target === "react" && neededHelpers.has("context")) {
    claim(reactContextArtifact(), "helper");
  }
  if (options.target === "react" && neededHelpers.has("depth")) {
    claim(reactDepthArtifact(), "helper");
  }
  if (options.target === "react" && reactStyles) {
    claim({ path: "react/styles.d.ts", content: 'declare module "*.css";\n' }, "helper");
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
      dependencies: Object.freeze(neededHelpers.has("html") ? { parse5: "^8.0.1" } : {}),
      peerDependencies: Object.freeze({ [options.target]: `^${targetVersion}${options.target === "svelte" ? "" : ".0"}` }),
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
  for (const { artifact } of planned) await emit(outputRoot, artifact);
  await mkdir(outputRoot, { recursive: true });
  await writeFile(
    resolve(outputRoot, inventory),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  return manifest;
}
