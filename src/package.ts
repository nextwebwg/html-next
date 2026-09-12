import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, normalize, resolve, sep } from "node:path";

import ts from "typescript";

import { generateComponent } from "./generate.js";
import type { ComponentPackageConfig } from "./package-config.js";
import { parseComponent } from "./parser.js";
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

function controllerTarget(definition: ComponentDefinition): string | undefined {
  if (definition.controller === undefined) return undefined;
  const extension = extname(definition.controller) || ".js";
  return `controllers/${definition.contract.tag}${extension}`;
}

async function addStaticModuleGraph(
  source: string,
  target: string,
  files: Map<string, string | { readonly copy: string }>,
  moduleSources: Map<string, string>,
  moduleDependencies: Map<string, readonly string[]>,
): Promise<void> {
  const sourcePath = resolve(source);
  const targetPath = normalize(target);
  if (isAbsolute(targetPath) || targetPath === ".." || targetPath.startsWith(`..${sep}`)) {
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
      normalize(join(dirname(targetPath), specifier)),
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
    'import { getComponentHost, observeDocument, registerComponentDefinitions, setControllerModule } from "@nextwebwg/html/runtime";',
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

/** Assembles generated components and explicit pass-through assets into one inspectable package. */
export async function assembleComponentPackage(config: ComponentPackageConfig): Promise<AssembledPackage> {
  const root = resolve(config.outDirectory);
  const files = new Map<string, string | { readonly copy: string }>();
  const definitions: ComponentDefinition[] = [];
  const controllers = new Map<string, string>();
  const moduleSources = new Map<string, string>();
  const moduleDependencies = new Map<string, readonly string[]>();
  const names = new Set<string>();

  for (const input of [...config.components].sort((left, right) => left.source.localeCompare(right.source))) {
    const sourcePath = resolve(input.source);
    const parsed = parseComponent(await readFile(sourcePath, "utf8"), sourcePath);
    const definition = Object.freeze({
      ...parsed,
      source: Object.freeze({ file: `./components/${basename(sourcePath)}` }),
    });
    if (names.has(definition.contract.tag)) throw new Error(`Duplicate package component <${definition.contract.tag}>.`);
    names.add(definition.contract.tag);
    const controller = controllerTarget(definition);
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
    files.set(`components/${basename(sourcePath)}`, { copy: sourcePath });
  }

  for (const edge of config.passThrough ?? []) {
    if (files.has(edge.target)) throw new Error(`Package artifact collision at ${edge.target}.`);
    files.set(edge.target, { copy: resolve(edge.source) });
  }
  files.set("dist/index.js", packageEntry(definitions, controllers));
  files.set("dist/index.d.ts", [
    'import type { ComponentDefinition } from "@nextwebwg/html";',
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
    peerDependencies: { "@nextwebwg/html": "^0.0.0" },
    exports: config.exports ?? {
      ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
      "./components/*": "./components/*",
      "./react/*": "./react/*",
      "./vue/*": "./vue/*",
      "./svelte/*": "./svelte/*",
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
