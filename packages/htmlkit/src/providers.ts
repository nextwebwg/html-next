import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { bundleServer } from "./bundle.js";
import type { BrowserDefinition } from "./types.js";
import type { ProviderModule } from "./provider-preparation.js";
import ts from "typescript-compiler";

interface ModuleHost {
  readonly cacheDir: string;
  resolve(specifier: string, importer: string): Promise<string | undefined>;
  watch(file: string): void;
}

function surface(file: string, source: string): { exports: ReadonlySet<string>; stars: readonly string[] } {
  if (/\.d\.[cm]?ts$/i.test(file)) return { exports: new Set(), stars: [] };
  // Use compiler erasure rather than mistaking an exported local type for a runtime value.
  const emitted = ts.transpileModule(source, { fileName: file,
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.Preserve } }).outputText;
  const parsed = ts.createSourceFile(file, emitted, ts.ScriptTarget.Latest);
  const names = new Set(["props", "create", "prepare", "adopt"]);
  const exports = new Set<string>();
  const add = (name: string): void => { if (names.has(name)) exports.add(name); };
  const binding = (name: ts.BindingName): void => {
    if (ts.isIdentifier(name)) add(name.text);
    else for (const element of name.elements) if (ts.isBindingElement(element)) binding(element.name);
  };
  const stars: string[] = [];
  for (const statement of parsed.statements) {
    if (ts.isExportDeclaration(statement)) {
      const clause = statement.exportClause;
      if (clause === undefined) {
        if (statement.moduleSpecifier !== undefined && ts.isStringLiteral(statement.moduleSpecifier)) stars.push(statement.moduleSpecifier.text);
      } else if (ts.isNamedExports(clause)) for (const element of clause.elements) add(element.name.text);
      else add(clause.name.text);
      continue;
    }
    const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
    if (!modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword) ||
      modifiers.some(modifier => modifier.kind === ts.SyntaxKind.DefaultKeyword)) continue;
    if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) binding(declaration.name);
    else if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name !== undefined) add(statement.name.text);
  }
  return { exports, stars };
}

export function createProviderModules(root: string, host: ModuleHost) {
  const revision = randomUUID();
  const abort = new AbortController();
  const cache = new Map<string, Promise<ProviderModule | undefined>>();
  const surfaces = new Map<string, Promise<ReturnType<typeof surface>>>();
  const exportsOf = async (file: string, seen = new Set<string>()): Promise<Set<string>> => {
    if (seen.has(file)) return new Set();
    seen.add(file);
    let parsed = surfaces.get(file);
    if (parsed === undefined) {
      host.watch(file);
      parsed = readFile(file, { encoding: "utf8", signal: abort.signal }).then(source => surface(file, source));
      surfaces.set(file, parsed);
    }
    const found = await parsed;
    const names = new Set(found.exports);
    for (const specifier of found.stars) {
      const resolved = await host.resolve(specifier, file);
      if (resolved !== undefined) for (const name of await exportsOf(resolved, seen)) names.add(name);
    }
    return names;
  };
  let temporary: Promise<string> | undefined;
  let batch = 0;
  let closing: Promise<void> | undefined;
  return {
    async resolve(components: readonly (BrowserDefinition & { readonly privateReaderNames?: readonly string[] })[]): Promise<readonly BrowserDefinition[]> {
      abort.signal.throwIfAborted();
      const missing = [...new Set(components.flatMap(component => component.module === undefined ? [] : [component.module]))].filter(file => !cache.has(file));
      if (missing.length > 0) {
        const id = batch++;
        // Keep native package resolution rooted in the app; Vite excludes its cache from watching.
        const directory = (): Promise<string> => (temporary ??= (async () => {
          await mkdir(host.cacheDir, { recursive: true });
          const directory = await mkdtemp(join(host.cacheDir, "htmlkit-providers-"));
          try { await writeFile(join(directory, "package.json"), '{"type":"module"}'); }
          catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
          return directory;
        })()).then(path => join(path, String(id)));
        const eligible = Promise.all(missing.map(async file => {
          const names = await exportsOf(file);
          return names.has("props") || names.has("create") || names.has("prepare") && names.has("adopt");
        }));
        const bundled = (async () => {
          const selected = (await eligible).flatMap((include, i) => include ? [[`provider-${i}`, missing[i]!]] : []);
          const result = selected.length === 0 ? undefined : await bundleServer({ root, outDir: await directory(), inputs: Object.fromEntries(selected) }, abort.signal);
          for (const file of result?.inputs ?? []) host.watch(file);
          return result;
        })();
        for (const [i, file] of missing.entries()) cache.set(file, (async () => {
          const result = await bundled;
          const entry = result?.entries[`provider-${i}`];
          if (entry === undefined) return undefined;
          const bound = entry.exports.includes("prepare") && entry.exports.includes("adopt");
          if (!bound && !entry.exports.some(name => name === "props" || name === "create")) return undefined;
          return { module: pathToFileURL(join(await directory(), entry.file)).href, source: `${revision}:${id}:${i}`, ...bound ? { bound: true as const } : {} };
        })());
      }
      return Promise.all(components.map(async component => {
        const provider = component.module === undefined ? undefined : await cache.get(component.module);
        if (provider?.bound && (component.client !== undefined || component.server !== undefined)) {
          throw new TypeError(`${component.module}: environment provider overrides require an unbound props/create module; a prepared module owns its binding instance.`);
        }
        if (provider === undefined && component.server !== undefined) throw new TypeError(`${component.server}: private readers require a common provider module.`);
        const identity = createHash("sha256").update(`${component.definition.source.file}\0${component.definition.contract.tag}`).digest("hex").slice(0, 16);
        return provider === undefined ? component : { ...component, binding: { ...provider, source: `${provider.source}:${identity}`,
          ...component.client === undefined ? {} : { client: true }, ...component.privateReaderNames === undefined ? {} : { readers: component.privateReaderNames } } };
      }));
    },
    close(): Promise<void> {
      return closing ??= (async () => {
        abort.abort(new Error("HTMLKit provider modules are closed."));
        await Promise.allSettled([...cache.values(), ...surfaces.values()]);
        const directory = await temporary?.catch(() => undefined);
        if (directory !== undefined) await rm(directory, { recursive: true, force: true });
      })();
    },
  };
}
