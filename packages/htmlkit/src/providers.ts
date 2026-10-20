import { randomUUID } from "node:crypto";
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

function surface(file: string, source: string): { provider: boolean; stars: readonly string[] } {
  if (/\.d\.[cm]?ts$/i.test(file)) return { provider: false, stars: [] };
  // Use compiler erasure rather than mistaking an exported local type for a runtime value.
  const emitted = ts.transpileModule(source, { fileName: file,
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.Preserve } }).outputText;
  const parsed = ts.createSourceFile(file, emitted, ts.ScriptTarget.Latest);
  const names = new Set(["props", "create"]);
  const binding = (name: ts.BindingName): boolean => ts.isIdentifier(name) ? names.has(name.text)
    : name.elements.some(element => ts.isBindingElement(element) && binding(element.name));
  let provider = false;
  const stars: string[] = [];
  for (const statement of parsed.statements) {
    if (ts.isExportDeclaration(statement)) {
      const clause = statement.exportClause;
      if (clause === undefined) {
        if (statement.moduleSpecifier !== undefined && ts.isStringLiteral(statement.moduleSpecifier)) stars.push(statement.moduleSpecifier.text);
      } else if (ts.isNamedExports(clause)) provider ||= clause.elements.some(element => names.has(element.name.text));
      else provider ||= names.has(clause.name.text);
      continue;
    }
    const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
    if (!modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword) ||
      modifiers.some(modifier => modifier.kind === ts.SyntaxKind.DefaultKeyword)) continue;
    if (ts.isVariableStatement(statement)) provider ||= statement.declarationList.declarations.some(declaration => binding(declaration.name));
    else if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) provider ||= statement.name !== undefined && names.has(statement.name.text);
  }
  return { provider, stars };
}

export function createProviderModules(root: string, host: ModuleHost) {
  const revision = randomUUID();
  const abort = new AbortController();
  const cache = new Map<string, Promise<ProviderModule | undefined>>();
  const surfaces = new Map<string, Promise<ReturnType<typeof surface>>>();
  const provider = async (file: string, seen = new Set<string>()): Promise<boolean> => {
    if (seen.has(file)) return false;
    seen.add(file);
    let parsed = surfaces.get(file);
    if (parsed === undefined) {
      host.watch(file);
      parsed = readFile(file, { encoding: "utf8", signal: abort.signal }).then(source => surface(file, source));
      surfaces.set(file, parsed);
    }
    const found = await parsed;
    if (found.provider) return true;
    for (const specifier of found.stars) {
      const resolved = await host.resolve(specifier, file);
      if (resolved !== undefined && await provider(resolved, seen)) return true;
    }
    return false;
  };
  let temporary: Promise<string> | undefined;
  let batch = 0;
  let closing: Promise<void> | undefined;
  return {
    async resolve(components: readonly BrowserDefinition[]): Promise<readonly BrowserDefinition[]> {
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
        const eligible = Promise.all(missing.map(file => provider(file)));
        const bundled = (async () => {
          const selected = (await eligible).flatMap((include, i) => include ? [[`provider-${i}`, missing[i]!]] : []);
          const result = selected.length === 0 ? undefined : await bundleServer({ root, outDir: await directory(), inputs: Object.fromEntries(selected) }, abort.signal);
          for (const file of result?.inputs ?? []) host.watch(file);
          return result;
        })();
        for (const [i, file] of missing.entries()) cache.set(file, (async () => {
          const result = await bundled;
          const entry = result?.entries[`provider-${i}`];
          if (entry === undefined || !entry.exports.some(name => name === "props" || name === "create")) return undefined;
          return { module: pathToFileURL(join(await directory(), entry.file)).href, source: `${revision}:${id}:${i}` };
        })());
      }
      return Promise.all(components.map(async component => {
        const provider = component.module === undefined ? undefined : await cache.get(component.module);
        return provider === undefined ? component : { ...component, binding: { ...provider, source: `${provider.source}:${component.definition.contract.tag}`,
          ...component.client === undefined ? {} : { client: true } } };
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
