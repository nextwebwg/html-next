import { existsSync } from "node:fs";
import { glob, lstat, readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { ComponentGraph } from "./graph.js";
import { buildComponentGraph } from "./source-graph.js";
import {
  isWithinTrustRoot,
  type ComponentResourceResolver,
  type ResolvedResource,
} from "./resolve.js";
import { fail, HtmlDiagnosticError } from "./diagnostics.js";
import { createStylesheetLoader } from "./stylesheet-resources.js";
import { parseStylesheetForBuild } from "./stylesheet-resources-build.js";

export interface InspectedModule {
  readonly url: string;
  /** Already-resolved static ESM dependency URLs. */
  readonly dependencies: readonly string[];
}

export interface NodeLoaderOptions {
  /** Check-only recovery. Rejects with all collected compiler diagnostics. */
  readonly collectDiagnostics?: boolean;
  readonly baseURL?: string;
  readonly resolvePackage?: (specifier: string, parentURL: string) => ResolvedResource;
  readonly readComponent?: (url: string) => Promise<{ readonly url: string; readonly source: string }>;
  readonly readStylesheet?: (url: string) => Promise<{ readonly url: string; readonly source: string }>;
  /** A host bundler can resolve CSS aliases and package paths through its own resolver. */
  readonly resolveStylesheet?: (specifier: string, parentURL: string) => Promise<string | undefined>;
  readonly stylesheetAssetURL?: (url: string) => string;
  readonly inspectModule?: (url: string) => Promise<InspectedModule>;
}

export interface NodeComponentGraph extends ComponentGraph {
  readonly moduleInputs: readonly string[];
  readonly stylesheetInputs: readonly string[];
}

function directory(url: string): string {
  return new URL("./", url).href;
}

/**
 * The build's filesystem boundary for a root: the package that contains it (the nearest directory
 * with a package.json), or the root's own directory outside any package. The live loader has no
 * directory trust root (`../` is location, not authority); this is a build-tool output constraint,
 * so sibling components and shared controller modules in one package resolve, and nothing outside
 * the package is read or copied.
 */
function hasPackageJson(directoryURL: URL): boolean {
  try {
    return existsSync(fileURLToPath(new URL("package.json", directoryURL)));
  } catch {
    // Not a local path on this platform (a synthetic file: URL); treat it as outside any package.
    return false;
  }
}

function packageRoot(url: string): string {
  if (!url.startsWith("file:")) return directory(url);
  for (let candidate = new URL("./", url); ; candidate = new URL("../", candidate)) {
    if (hasPackageJson(candidate)) return candidate.href;
    if (new URL("../", candidate).href === candidate.href) return directory(url);
  }
}

class NodeResourceResolver implements ComponentResourceResolver {
  constructor(
    private readonly baseURL: string,
    private readonly resolvePackage: (specifier: string, parentURL: string) => ResolvedResource,
  ) {}

  private resolveBare(specifier: string, parentURL: string): ResolvedResource {
    try {
      return this.resolvePackage(specifier, parentURL);
    } catch (error) {
      if (error instanceof HtmlDiagnosticError) throw error;
      const code = error !== null && typeof error === "object" && "code" in error ? error.code : undefined;
      if (code === "ERR_MODULE_NOT_FOUND" || code === "ERR_PACKAGE_PATH_NOT_EXPORTED" ||
        code === "ERR_PACKAGE_IMPORT_NOT_DEFINED" || code === "ERR_INVALID_PACKAGE_TARGET") {
        fail("HL002", `Bare resource specifier \`${specifier}\` cannot be resolved by the consuming project: ${error instanceof Error ? error.message : String(error)}.`, parentURL);
      }
      throw error;
    }
  }

  resolveRoot(specifier: string): ResolvedResource {
    if (/^(?:[A-Za-z][A-Za-z\d+.-]*:|\/|\.\.?\/)/.test(specifier)) {
      const url = new URL(specifier, this.baseURL).href;
      return { url, trustRoot: packageRoot(url) };
    }
    return this.resolveBare(specifier, this.baseURL);
  }

  resolveDependency(specifier: string, parentURL: string, parentTrustRoot: string): ResolvedResource {
    if (!/^(?:[A-Za-z][A-Za-z\d+.-]*:|\/|\.\.?\/)/.test(specifier)) {
      return this.resolveBare(specifier, parentURL);
    }
    const url = new URL(specifier, parentURL).href;
    if (!isWithinTrustRoot(url, parentTrustRoot)) {
      fail("HL003", `Dependency \`${specifier}\` escapes approved root \`${parentTrustRoot}\`.`, parentURL);
    }
    return { url, trustRoot: parentTrustRoot };
  }

  assertFinalURL(resource: ResolvedResource, finalURL: string, source = resource.url): string {
    const url = new URL(finalURL, resource.url).href;
    if (!isWithinTrustRoot(url, resource.trustRoot)) {
      fail("HL004", `Final component URL \`${url}\` escapes approved root \`${resource.trustRoot}\`.`, source);
    }
    return url;
  }
}

/** Builds a package graph without importing controller modules. */
export async function loadNodeComponents(
  rootSpecifiers: readonly string[],
  options: NodeLoaderOptions = {},
): Promise<NodeComponentGraph> {
  const baseURL = options.baseURL ?? new URL("../", import.meta.url).href;
  const resolvePackage = options.resolvePackage ?? ((specifier: string, parentURL: string) => {
    const url = (import.meta.resolve as (value: string, parent?: string) => string)(specifier, parentURL);
    return { url, trustRoot: packageRoot(url) };
  });
  const readComponent = options.readComponent ?? (async (url: string) => ({
    url,
    source: await readFile(fileURLToPath(url), "utf8"),
  }));
  const resolver = new NodeResourceResolver(baseURL, resolvePackage);
  const styles = createStylesheetLoader({
    parse: parseStylesheetForBuild,
    fetch: options.readStylesheet ?? readComponent,
    resolve: async (specifier, parent) => {
      const hosted = await options.resolveStylesheet?.(specifier, parent.url);
      return hosted === undefined
        ? resolver.resolveDependency(new URL(specifier, parent.url).href, parent.url, parent.trustRoot)
        : { url: hosted, trustRoot: packageRoot(hosted) };
    },
    assertFinalURL: (resource, finalURL) => resolver.assertFinalURL(resource, finalURL),
    ...(options.stylesheetAssetURL === undefined ? {} : { assetURL: options.stylesheetAssetURL }),
  });
  const graph = await buildComponentGraph(rootSpecifiers, {
    resolver,
    fetchComponent: readComponent,
    prepareStyles: styles.prepare,
    ...(options.collectDiagnostics === undefined ? {} : { collectDiagnostics: options.collectDiagnostics }),
  });

  const moduleInputs = new Set<string>();
  if (options.inspectModule !== undefined) {
    const visit = async (url: string): Promise<void> => {
      if (moduleInputs.has(url)) return;
      moduleInputs.add(url);
      const module = await options.inspectModule!(url);
      for (const dependency of module.dependencies) await visit(dependency);
    };
    for (const node of graph.nodes.values()) {
      if (node.controller !== undefined) await visit(node.controller.url);
    }
  } else {
    for (const node of graph.nodes.values()) {
      if (node.controller !== undefined) moduleInputs.add(node.controller.url);
    }
  }

  return Object.freeze({
    ...graph,
    moduleInputs: Object.freeze([...moduleInputs].sort()),
    stylesheetInputs: Object.freeze([...styles.inputs].sort()),
  });
}

function hasGlob(pattern: string): boolean {
  return pattern.includes("*") || pattern.includes("?") || pattern.includes("[") || pattern.includes("{");
}

/** A file remains an entry; a glob or directory expands to every HTML component below it. */
export async function expandComponentEntries(projectRoot: string, patterns: readonly string[]): Promise<string[]> {
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
    if (matches.length === 0) throw new Error(`Component input ${JSON.stringify(pattern)} matched no HTML component files.`);
    entries.push(...matches.sort());
  }
  return entries;
}
