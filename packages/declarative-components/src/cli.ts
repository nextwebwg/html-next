#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import ts from "typescript-compiler";

import {
  generateComponent,
  GENERATOR_VERSION,
  type GeneratedArtifact,
} from "./generate.js";
import { loadNodeComponents, type NodeComponentGraph } from "./node-loader.js";

export type BuildTarget = "docs" | "react" | "styles" | "svelte" | "vanilla" | "vue";

export interface BuildOptions {
  readonly targets?: readonly BuildTarget[];
}

export interface BuildManifest {
  readonly generatorVersion: string;
  readonly components: readonly {
    readonly source: string;
    readonly name: string;
    readonly tag: string;
    readonly artifacts: readonly string[];
    readonly dependencies: readonly string[];
    readonly controller: null | string;
  }[];
}

/** The controller module and its static relative imports, by file URL. */
async function readControllerGraph(sourceURL: string, files: Map<string, string>): Promise<void> {
  if (files.has(sourceURL)) return;
  const content = await readFile(fileURLToPath(sourceURL), "utf8");
  files.set(sourceURL, content);
  for (const item of ts.preProcessFile(content, true, true).importedFiles) {
    if (!item.fileName.startsWith(".") && !item.fileName.startsWith("/")) continue;
    await readControllerGraph(new URL(item.fileName, sourceURL).href, files);
  }
}

/** The deepest directory containing every path. */
function commonDirectory(paths: readonly string[]): string {
  let common = dirname(paths[0]!);
  for (const path of paths.slice(1)) {
    while (relative(common, path).startsWith(`..${sep}`)) common = dirname(common);
  }
  return common;
}

/**
 * Copies a controller and its relative imports under `targetRoot`, named relative to the deepest
 * directory that holds the whole graph: the component's own directory unless the controller imports
 * a shared module beside it. The graph must stay inside the component's package (`trustRoot`).
 */
async function addControllerGraph(
  sourceURL: string,
  trustRoot: string,
  targetRoot: string,
  artifacts: Map<string, GeneratedArtifact>,
): Promise<string> {
  const files = new Map<string, string>();
  await readControllerGraph(sourceURL, files);
  const root = fileURLToPath(trustRoot);
  const paths = [...files.keys()].map((url) => fileURLToPath(url));
  for (const path of paths) {
    const withinRoot = relative(root, path);
    if (withinRoot === ".." || withinRoot.startsWith(`..${sep}`)) {
      throw new Error(`Controller module escaped its component root: ${path}.`);
    }
  }
  const base = commonDirectory(paths);
  const target = (path: string) => `${targetRoot}/${relative(base, path).split(sep).join("/")}`;
  for (const [url, content] of files) {
    const path = target(fileURLToPath(url));
    const prior = artifacts.get(path);
    if (prior !== undefined && prior.content !== content) throw new Error(`Generated artifact collision at ${path}.`);
    artifacts.set(path, { path, content });
  }
  return target(fileURLToPath(sourceURL));
}

async function componentGraph(entries: readonly string[]): Promise<NodeComponentGraph> {
  if (entries.length === 0) throw new Error("At least one component source is required.");
  const baseURL = pathToFileURL(`${process.cwd()}${sep}`).href;
  return loadNodeComponents(entries.map((entry) => pathToFileURL(resolve(entry)).href), {
    baseURL,
    inspectModule: async (url) => {
      const source = await readFile(fileURLToPath(url), "utf8");
      return {
        url,
        dependencies: ts.preProcessFile(source, true, true).importedFiles
          .map((item) => item.fileName)
          .filter((specifier) => specifier.startsWith(".") || specifier.startsWith("/"))
          .map((specifier) => new URL(specifier, url).href),
      };
    },
  });
}

export interface InspectedComponentGraph {
  readonly roots: readonly string[];
  readonly components: readonly {
    readonly tag: string;
    readonly source: string;
    readonly dependencies: readonly string[];
    readonly controller: null | string;
    readonly support: string;
  }[];
  readonly modules: readonly string[];
}

export async function inspectComponents(entries: readonly string[]): Promise<InspectedComponentGraph> {
  const graph = await componentGraph(entries);
  const display = (url: string): string => url.startsWith("file:")
    ? relative(process.cwd(), fileURLToPath(url)).split(sep).join("/")
    : url;
  return Object.freeze({
    roots: Object.freeze(graph.roots.map(display)),
    components: Object.freeze([...graph.nodes.values()].map((node) => Object.freeze({
      tag: node.definition.contract.tag,
      source: display(node.url),
      dependencies: Object.freeze(node.dependencies.map(display)),
      controller: node.controller === undefined ? null : display(node.controller.url),
      support: node.definition.contract.status,
    }))),
    modules: Object.freeze(graph.moduleInputs.map(display)),
  });
}

export async function checkComponents(entries: readonly string[]): Promise<InspectedComponentGraph> {
  return inspectComponents(entries);
}

export async function buildComponents(
  entries: readonly string[],
  outDirectory: string,
  options: BuildOptions = {},
): Promise<BuildManifest> {
  if (entries.length === 0) throw new Error("Build requires at least one component source.");
  const normalizedEntries = entries.map((entry) => resolve(entry));
  if (new Set(normalizedEntries).size !== normalizedEntries.length) {
    throw new Error("Generated artifact collision: the same component source was provided more than once.");
  }

  const outputRoot = resolve(outDirectory);
  const artifacts = new Map<string, GeneratedArtifact>();
  const components: Array<BuildManifest["components"][number]> = [];
  const selected = new Set(options.targets ?? ["docs", "react", "styles", "svelte", "vanilla", "vue"]);
  const graph = await componentGraph(entries);
  const displayPath = (url: string): string => relative(process.cwd(), fileURLToPath(url)).split(sep).join("/");

  for (const node of [...graph.nodes.values()].sort((left, right) => left.url.localeCompare(right.url))) {
    const entry = fileURLToPath(node.url);
    const controllerTarget = node.controller === undefined ? undefined : await addControllerGraph(
      node.controller.url,
      node.trustRoot,
      `controllers/${node.definition.contract.tag}`,
      artifacts,
    );
    const definition = controllerTarget === undefined
      ? node.definition
      : Object.freeze({ ...node.definition, controller: `../${controllerTarget}` });
    const generated = generateComponent(definition).filter((artifact) => selected.has(artifact.path.split("/", 1)[0] as BuildTarget));
    for (const artifact of generated) {
      if (artifacts.has(artifact.path)) {
        throw new Error(`Generated artifact collision at ${artifact.path}.`);
      }
      artifacts.set(artifact.path, artifact);
    }
    components.push({
      source: relative(process.cwd(), entry).split(sep).join("/"),
      name: definition.contract.name,
      tag: definition.contract.tag,
      artifacts: generated.map((artifact) => artifact.path),
      dependencies: node.dependencies.map(displayPath),
      controller: node.controller === undefined ? null : displayPath(node.controller.url),
    });
  }

  await mkdir(outputRoot, { recursive: true });
  for (const artifact of artifacts.values()) {
    const path = resolve(outputRoot, artifact.path);
    if (path !== outputRoot && !path.startsWith(`${outputRoot}${sep}`)) {
      throw new Error(`Generated artifact escaped the output directory: ${artifact.path}.`);
    }
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, artifact.content, "utf8");
  }

  const manifest: BuildManifest = {
    generatorVersion: GENERATOR_VERSION,
    components,
  };
  await writeFile(
    resolve(outputRoot, "html.manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  return manifest;
}

function usage(): string {
  return "Usage: html-next <check|inspect|build> <component.html...> [--target <target>] [--out-dir <directory>]";
}

async function main(argv: readonly string[]): Promise<void> {
  if (argv[0] === "check" || argv[0] === "inspect") {
    if (argv.length < 2) throw new Error(usage());
    const result = await inspectComponents(argv.slice(1));
    if (argv[0] === "inspect") process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (argv[0] !== "build") throw new Error(usage());
  const outIndex = argv.indexOf("--out-dir");
  const outDirectory = argv[outIndex + 1];
  if (outIndex < 2 || outDirectory === undefined) {
    throw new Error(usage());
  }
  const targetArgs = argv.slice(outIndex + 2);
  const targets: BuildTarget[] = [];
  for (let index = 0; index < targetArgs.length; index += 2) {
    if (targetArgs[index] !== "--target" || targetArgs[index + 1] === undefined) throw new Error(usage());
    targets.push(targetArgs[index + 1] as BuildTarget);
  }
  const allowed = new Set<BuildTarget>(["docs", "react", "styles", "svelte", "vanilla", "vue"]);
  if (targets.some((target) => !allowed.has(target))) throw new Error(`Unknown build target: ${targets.find((target) => !allowed.has(target))}.`);
  await buildComponents(argv.slice(1, outIndex), outDirectory, targets.length === 0 ? {} : { targets });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
