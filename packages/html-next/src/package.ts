import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, posix, relative, resolve, sep } from "node:path";

import ts from "typescript-compiler";

import { generateComponent, GENERATOR_VERSION, importsVueHost, importsVueHtml, importsVueControl, importsVueProps, vueHostArtifact, vueHtmlArtifact, vueControlArtifact, vuePropsArtifact } from "./generate.js";
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
    'import { getComponentHost, observeDocument, registerComponentDefinitions } from "@nextwebwg/html-next/runtime";',
    "",
    `export const definitions = ${JSON.stringify(definitions)};`,
    "const controllerImports = {",
    ...imports,
    "};",
    "",
    "const active = new WeakMap();",
    "const initialized = new WeakSet();",
    "export function register(root = document) {",
    "  registerComponentDefinitions(definitions, root);",
    "  return observeDocument(root, {",
    "    onConnect(element, definition) {",
    "      const load = controllerImports[definition.contract.tag];",
    "      if (load == null) return;",
    "      let disposed = false; let cleanup;",
    "      const module = load();",
    "      module.then(value => {",
    "        if (disposed) return;",
    "        const host = getComponentHost(element);",
    "        if (initialized.has(host)) return;",
    "        initialized.add(host);",
    "        return value.default(host);",
    "      }).then(value => {",
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

function targetIndexes(definitions: readonly ComponentDefinition[]): Readonly<Record<string, string>> {
  const entries = [...definitions].sort((left, right) => left.contract.name.localeCompare(right.contract.name));
  const names = new Set(entries.map((definition) => definition.contract.name));
  const exported = entries.flatMap((definition) => {
    const legacy = definition.contract.name.replace(/^Ui(?=[A-Z])/, "");
    const aliases = [definition.contract.name];
    if (legacy !== definition.contract.name && !names.has(legacy)) {
      aliases.push(legacy);
      names.add(legacy);
    }
    return aliases.map((name) => ({ name, definition }));
  });
  const exportsFor = (extension: string): string => exported.map(({ name, definition }) =>
    `export { default as ${name} } from ${JSON.stringify(`./${definition.contract.name}.${extension}`)};`
  ).join("\n") + "\n";
  return Object.freeze({
    "vue/index.js": exportsFor("vue"),
    "vanilla/index.js": entries.map((definition) =>
      `export * from ${JSON.stringify(`./${definition.contract.name}.js`)};`
    ).join("\n") + "\n",
    "vue/index.d.ts": [
      'import type { DefineComponent } from "vue";',
      "export interface VueAdapterEventMap { [name: string]: unknown }",
      ...exported.map(({ name }) => `export declare const ${name}: DefineComponent<Record<string, unknown>>;`),
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
    const parsedResource = parseComponentResource(await readFile(sourcePath, "utf8"), sourcePath);
    const source = componentPath(sourcePath);
    for (const parsed of parsedResource.definitions) {
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
      const generated = config.sourceOnly ? [] : generateComponent(generatedDefinition(definition, controller));
      for (const artifact of generated) {
        if (files.has(artifact.path)) throw new Error(`Package artifact collision at ${artifact.path}.`);
        files.set(artifact.path, artifact.content);
      }
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
  if ([...files.values()].some((content) => typeof content === "string" && importsVueHost(content))) {
    const host = vueHostArtifact();
    if (files.has(host.path)) throw new Error(`Package artifact collision at ${host.path}.`);
    files.set(host.path, host.content);
  }
  if ([...files.values()].some((content) => typeof content === "string" && importsVueHtml(content))) {
    const html = vueHtmlArtifact();
    if (files.has(html.path)) throw new Error(`Package artifact collision at ${html.path}.`);
    files.set(html.path, html.content);
  }
  if ([...files.values()].some((content) => typeof content === "string" && importsVueControl(content))) {
    const control = vueControlArtifact();
    if (files.has(control.path)) throw new Error(`Package artifact collision at ${control.path}.`);
    files.set(control.path, control.content);
  }
  if ([...files.values()].some((content) => typeof content === "string" && importsVueProps(content))) {
    const props = vuePropsArtifact();
    if (files.has(props.path)) throw new Error(`Package artifact collision at ${props.path}.`);
    files.set(props.path, props.content);
  }
  const publicNames = new Set<string>();
  for (const definition of definitions) {
    if (publicNames.has(definition.contract.name)) throw new Error(`Duplicate package export ${definition.contract.name}.`);
    publicNames.add(definition.contract.name);
  }
  const sourceEntry = "html-next/index.js";
  if (files.has(sourceEntry)) throw new Error(`Package artifact collision at ${sourceEntry}.`);
  files.set(sourceEntry, [...definitions].sort((a, b) => a.contract.name.localeCompare(b.contract.name)).map((definition) =>
    `export { ${definition.contract.name} } from ${JSON.stringify(`../${definition.source.file.slice(2)}`)};`
  ).join("\n") + "\n");
  if (!config.sourceOnly) {
    for (const [target, content] of Object.entries(targetIndexes(definitions))) {
      if (files.has(target)) throw new Error(`Package artifact collision at ${target}.`);
      files.set(target, content);
    }
    files.set("dist/index.js", packageEntry(definitions, controllers));
    files.set("dist/index.d.ts", [
      'import type { ComponentDefinition } from "@nextwebwg/html-next";',
      "export declare const definitions: readonly ComponentDefinition[];",
      "export declare function register(root?: Document): () => void;",
      "export declare const stop: undefined | (() => void);",
      "",
    ].join("\n"));
  }
  const packageJson = {
    name: config.name,
    version: config.version,
    type: "module",
    sideEffects: [...(config.sourceOnly ? [] : ["./dist/index.js"]), "**/*.css"],
    peerDependencies: { ...(config.sourceOnly ? {} : { "@nextwebwg/html-next": `^${GENERATOR_VERSION}` }), ...config.peerDependencies },
    ...(config.peerDependenciesMeta === undefined ? {} : { peerDependenciesMeta: config.peerDependenciesMeta }),
    exports: config.exports ?? (config.sourceOnly ? {
      ".": { "html-next": `./${sourceEntry}` },
      "./components/*": "./components/*",
    } : {
      ".": { "html-next": `./${sourceEntry}`, types: "./dist/index.d.ts", import: "./dist/index.js" },
      "./vue": { types: "./vue/index.d.ts", import: "./vue/index.js" },
      "./vanilla": "./vanilla/index.js",
      "./components/*": "./components/*",
      "./vue/*": "./vue/*",
      "./vanilla/*": "./vanilla/*",
      "./styles/*": "./styles/*",
    }),
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
