import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, posix, relative, resolve, sep } from "node:path";

import ts from "typescript-compiler";

import { generateComponent, GENERATOR_VERSION } from "./generate.js";
import type { ComponentPackageConfig } from "./package-config.js";
import { commonDirectory } from "./controller-files.js";
import { parseComponentResource } from "./source-graph.js";
import type { ComponentDefinition } from "./template.js";

export interface AssembledPackage {
  readonly components: readonly string[];
  readonly files: readonly string[];
}

function inside(root: string, path: string): string {
  const output = resolve(root, path);
  if (output !== root && !output.startsWith(`${root}${sep}`)) {
    throw new Error(`Package output escaped its directory: ${path}.`);
  }
  return output;
}


async function addStaticModuleGraph(
  source: string,
  target: string,
  files: Map<string, string | { readonly copy: string }>,
  moduleSources: Map<string, string>,
  moduleDependencies: Map<string, readonly string[]>,
): Promise<void> {
  const sourcePath = resolve(source);
  const targetPath = posix.normalize(target);
  if (posix.isAbsolute(targetPath) || targetPath === ".." || targetPath.startsWith("../")) {
    throw new Error(`Controller module output escaped the package: ${target}.`);
  }
  const priorSource = moduleSources.get(targetPath);
  if (priorSource !== undefined) {
    if (priorSource !== sourcePath) throw new Error(`Package artifact collision at ${targetPath}.`);
    return;
  }
  if (files.has(targetPath)) throw new Error(`Package artifact collision at ${targetPath}.`);

  const sourceText = await readFile(sourcePath, "utf8");
  moduleSources.set(targetPath, sourcePath);
  files.set(targetPath, { copy: sourcePath });
  const imports = ts.preProcessFile(sourceText, true, true).importedFiles.map((entry) => entry.fileName);
  moduleDependencies.set(targetPath, Object.freeze([...imports].sort()));
  for (const specifier of imports.filter((entry) => entry.startsWith("./") || entry.startsWith("../"))) {
    if (specifier.includes("?") || specifier.includes("#")) {
      throw new Error(`Controller module specifier must not contain a query or fragment: ${specifier}.`);
    }
    await addStaticModuleGraph(
      resolve(dirname(sourcePath), specifier),
      posix.join(posix.dirname(targetPath), specifier),
      files,
      moduleSources,
      moduleDependencies,
    );
  }
}

function generatedDefinition(definition: ComponentDefinition, controller: string | undefined): ComponentDefinition {
  if (controller === undefined) return definition;
  return Object.freeze({ ...definition, controller: `../${controller}` });
}

function packageEntry(definitions: readonly ComponentDefinition[], controllers: ReadonlyMap<string, string>): string {
  const imports = [...controllers].map(([tag, path], index) =>
    `  ${JSON.stringify(tag)}: () => import(${JSON.stringify(`../${path}`)}), // controller ${index + 1}`
  );
  return [
    'import { getComponentHost, observeDocument, registerComponentDefinitions, setControllerModule } from "@nextwebwg/declarative-components/runtime";',
    "",
    `export const definitions = ${JSON.stringify(definitions)};`,
    "const controllerImports = {",
    ...imports,
    "};",
    "",
    "const active = new WeakMap();",
    "export function register(root = document) {",
    "  registerComponentDefinitions(definitions, root);",
    "  return observeDocument(root, {",
    "    onConnect(element, definition) {",
    "      const load = controllerImports[definition.contract.tag];",
    "      if (load == null) return;",
    "      let disposed = false; let cleanup;",
    "      const module = load();",
    "      setControllerModule(element, module);",
    "      module.then(value => value.default(getComponentHost(element))).then(value => {",
    "        if (typeof value !== 'function') return;",
    "        if (disposed) value(); else cleanup = value;",
    "      });",
    "      const dispose = () => { disposed = true; cleanup?.(); active.delete(element); };",
    "      active.set(element, dispose);",
    "      return dispose;",
    "    },",
    "  });",
    "}",
    "",
    "export const stop = typeof document === 'undefined' ? undefined : register(document);",
    "",
  ].join("\n");
}

function publicName(definition: ComponentDefinition): string {
  return definition.contract.name.replace(/^Ui(?=[A-Z])/, "");
}

function targetIndexes(definitions: readonly ComponentDefinition[]): Readonly<Record<string, string>> {
  const entries = [...definitions].sort((left, right) => left.contract.name.localeCompare(right.contract.name));
  const exportsFor = (extension: string): string => entries.map((definition) =>
    `export { default as ${publicName(definition)} } from ${JSON.stringify(`./${definition.contract.name}.${extension}`)};`
  ).join("\n") + "\n";
  return Object.freeze({
    "vue/index.js": exportsFor("vue"),
    "vanilla/index.js": entries.map((definition) =>
      `export * from ${JSON.stringify(`./${definition.contract.name}.js`)};`
    ).join("\n") + "\n",
    "vue/index.d.ts": [
      'import type { DefineComponent } from "vue";',
      "export interface VueAdapterEventMap { [name: string]: unknown }",
      ...entries.map((definition) => `export declare const ${publicName(definition)}: DefineComponent<Record<string, unknown>>;`),
      "",
    ].join("\n"),
  });
}

/** Assembles generated components and explicit pass-through assets into one inspectable package. */
export async function assembleComponentPackage(config: ComponentPackageConfig): Promise<AssembledPackage> {
  const root = resolve(config.outDirectory);
  const files = new Map<string, string | { readonly copy: string }>();
  const definitions: ComponentDefinition[] = [];
  const controllers = new Map<string, string>();
  const moduleSources = new Map<string, string>();
  const moduleDependencies = new Map<string, readonly string[]>();
  const passThroughModules = new Set<string>();
  const names = new Set<string>();
  // Component sources keep their layout under components/, so their dependency links and
  // controller specifiers resolve there as they do in the source tree, with no build.
  const sources = config.components.map((input) => resolve(input.source));
  const sourceRoot = commonDirectory(sources);
  const componentPath = (path: string): string => posix.join("components", relative(sourceRoot, path).split(sep).join("/"));

  for (const sourcePath of [...sources].sort()) {
    const parsed = parseComponentResource(await readFile(sourcePath, "utf8"), sourcePath).definition;
    const source = componentPath(sourcePath);
    const definition = Object.freeze({ ...parsed, source: Object.freeze({ file: `./${source}` }) });
    if (names.has(definition.contract.tag)) throw new Error(`Duplicate package component <${definition.contract.tag}>.`);
    names.add(definition.contract.tag);
    const controller = parsed.controller === undefined
      ? undefined
      : componentPath(resolve(dirname(sourcePath), parsed.controller));
    definitions.push(controller === undefined ? definition : Object.freeze({ ...definition, controller: `./${controller}` }));
    if (controller !== undefined) {
      controllers.set(definition.contract.tag, controller);
      await addStaticModuleGraph(
        resolve(dirname(sourcePath), parsed.controller!),
        controller,
        files,
        moduleSources,
        moduleDependencies,
      );
    }
    const generated = generateComponent(generatedDefinition(definition, controller));
    for (const artifact of generated) {
      if (files.has(artifact.path)) throw new Error(`Package artifact collision at ${artifact.path}.`);
      files.set(artifact.path, artifact.content);
    }
    files.set(source, { copy: sourcePath });
  }

  for (const edge of config.passThrough ?? []) {
    if (files.has(edge.target)) throw new Error(`Package artifact collision at ${edge.target}.`);
    if (edge.module) {
      const priorModules = new Set(moduleSources.keys());
      await addStaticModuleGraph(
        resolve(edge.source),
        edge.target,
        files,
        moduleSources,
        moduleDependencies,
      );
      for (const path of moduleSources.keys()) if (!priorModules.has(path)) passThroughModules.add(path);
    } else files.set(edge.target, { copy: resolve(edge.source) });
  }
  for (const [target, content] of Object.entries(targetIndexes(definitions))) {
    if (files.has(target)) throw new Error(`Package artifact collision at ${target}.`);
    files.set(target, content);
  }
  files.set("dist/index.js", packageEntry(definitions, controllers));
  files.set("dist/index.d.ts", [
    'import type { ComponentDefinition } from "@nextwebwg/declarative-components";',
    "export declare const definitions: readonly ComponentDefinition[];",
    "export declare function register(root?: Document): () => void;",
    "export declare const stop: undefined | (() => void);",
    "",
  ].join("\n"));
  const packageJson = {
    name: config.name,
    version: config.version,
    type: "module",
    sideEffects: ["./dist/index.js", "./*.css"],
    peerDependencies: { "@nextwebwg/declarative-components": `^${GENERATOR_VERSION}`, ...config.peerDependencies },
    ...(config.peerDependenciesMeta === undefined ? {} : { peerDependenciesMeta: config.peerDependenciesMeta }),
    exports: config.exports ?? {
      ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
      "./vue": { types: "./vue/index.d.ts", import: "./vue/index.js" },
      "./vanilla": "./vanilla/index.js",
      "./components/*": "./components/*",
      "./vue/*": "./vue/*",
      "./vanilla/*": "./vanilla/*",
      "./styles/*": "./styles/*",
    },
  };
  files.set("package.json", `${JSON.stringify(packageJson, null, 2)}\n`);
  files.set("html.manifest.json", `${JSON.stringify({
    schemaVersion: 1,
    components: definitions.map((definition) => ({
      tag: definition.contract.tag,
      source: definition.source.file,
      controller: controllers.get(definition.contract.tag) ?? null,
    })),
    passThrough: (config.passThrough ?? []).map((edge) => edge.target).sort(),
    controllerModules: [...moduleDependencies].sort(([left], [right]) => left.localeCompare(right))
      .filter(([path]) => !passThroughModules.has(path))
      .map(([path, dependencies]) => ({ path, dependencies })),
    passThroughModules: [...moduleDependencies].sort(([left], [right]) => left.localeCompare(right))
      .filter(([path]) => passThroughModules.has(path))
      .map(([path, dependencies]) => ({ path, dependencies })),
  }, null, 2)}\n`);

  await mkdir(root, { recursive: true });
  for (const [target, content] of [...files].sort(([left], [right]) => left.localeCompare(right))) {
    const output = inside(root, target);
    await mkdir(dirname(output), { recursive: true });
    if (typeof content === "string") await writeFile(output, content, "utf8");
    else await copyFile(content.copy, output);
  }
  return Object.freeze({
    components: Object.freeze([...names].sort()),
    files: Object.freeze([...files.keys()].sort()),
  });
}

export type { ComponentPackageConfig, PackageComponentInput, PackagePassThrough } from "./package-config.js";
