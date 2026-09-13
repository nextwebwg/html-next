import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import type { ComponentGraph } from "./graph.js";
import { buildComponentGraph } from "./source-graph.js";
import {
  isWithinTrustRoot,
  type ComponentResourceResolver,
  type ResolvedResource,
} from "./resolve.js";
import { fail } from "./diagnostics.js";

export interface InspectedModule {
  readonly url: string;
  /** Already-resolved static ESM dependency URLs. */
  readonly dependencies: readonly string[];
}

export interface NodeLoaderOptions {
  readonly baseURL?: string;
  readonly resolvePackage?: (specifier: string, parentURL: string) => ResolvedResource;
  readonly readComponent?: (url: string) => Promise<{ readonly url: string; readonly source: string }>;
  readonly inspectModule?: (url: string) => Promise<InspectedModule>;
}

export interface NodeComponentGraph extends ComponentGraph {
  readonly moduleInputs: readonly string[];
}

function directory(url: string): string {
  return new URL("./", url).href;
}

class NodeResourceResolver implements ComponentResourceResolver {
  constructor(
    private readonly baseURL: string,
    private readonly resolvePackage: (specifier: string, parentURL: string) => ResolvedResource,
  ) {}

  resolveRoot(specifier: string): ResolvedResource {
    if (/^(?:[A-Za-z][A-Za-z\d+.-]*:|\/|\.\.?\/)/.test(specifier)) {
      const url = new URL(specifier, this.baseURL).href;
      return { url, trustRoot: directory(url) };
    }
    return this.resolvePackage(specifier, this.baseURL);
  }

  resolveDependency(specifier: string, parentURL: string, parentTrustRoot: string): ResolvedResource {
    if (!/^(?:[A-Za-z][A-Za-z\d+.-]*:|\/|\.\.?\/)/.test(specifier)) {
      return this.resolvePackage(specifier, parentURL);
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
    return { url, trustRoot: directory(url) };
  });
  const readComponent = options.readComponent ?? (async (url: string) => ({
    url,
    source: await readFile(fileURLToPath(url), "utf8"),
  }));
  const graph = await buildComponentGraph(rootSpecifiers, {
    resolver: new NodeResourceResolver(baseURL, resolvePackage),
    fetchComponent: readComponent,
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
  });
}
