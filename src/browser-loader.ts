import { buildComponentGraph, type ComponentGraph } from "./graph.js";
import { ComponentRegistry } from "./registry.js";
import { ResourceResolver, type ImportMapLike } from "./resolve.js";
import { loadController, type ModuleImporter } from "./controller.js";
import { getComponentHost, installComponentGraph, observeDocument } from "./runtime.js";

export interface BrowserLoaderOptions {
  readonly document?: Document;
  readonly importMap?: ImportMapLike;
  readonly fetch?: typeof fetch;
  readonly importer?: ModuleImporter;
  readonly registry?: ComponentRegistry;
  readonly onError?: (error: unknown) => void;
}

function readImportMap(root: Document): ImportMapLike {
  const imports: Record<string, string> = {};
  for (const script of Array.from(root.querySelectorAll('script[type="importmap"]'))) {
    const parsed = JSON.parse(script.textContent ?? "{}") as ImportMapLike;
    Object.assign(imports, parsed.imports ?? {});
  }
  return { imports };
}

/** Loads explicitly selected live component roots and registers their inert definition graph. */
export async function loadBrowserComponents(
  rootSpecifiers: readonly string[],
  options: BrowserLoaderOptions = {},
): Promise<{ readonly graph: ComponentGraph; readonly registry: ComponentRegistry }> {
  const root = options.document ?? document;
  const request = options.fetch ?? fetch;
  const resolver = new ResourceResolver(options.importMap ?? readImportMap(root), root.baseURI);
  const graph = await buildComponentGraph(rootSpecifiers, {
    resolver,
    fetchComponent: async (url) => {
      const response = await request(url);
      if (!response.ok) throw new TypeError(`Component request \`${url}\` failed with ${response.status}.`);
      return { url: response.url || url, source: await response.text() };
    },
    isCustomElementRegistered: (tag) => root.defaultView?.customElements.get(tag) !== undefined,
  });
  const registry = options.registry ?? new ComponentRegistry();
  registry.addGraph(graph, (node) => loadController(node, options.importer));
  return Object.freeze({ graph, registry });
}

/** Reads the application's direct live roots from link[rel=component]. */
export function documentComponentRoots(root: Document = document): readonly string[] {
  return Object.freeze(
    Array.from(root.querySelectorAll('link[rel="component"][href]'))
      .map((link) => link.getAttribute("href")!)
      .filter((href) => href.trim() !== ""),
  );
}

export function loadDocumentComponents(
  root: Document = document,
  options: Omit<BrowserLoaderOptions, "document"> = {},
): Promise<{ readonly graph: ComponentGraph; readonly registry: ComponentRegistry }> {
  return loadBrowserComponents(documentComponentRoots(root), { ...options, document: root });
}

export interface StartedBrowserComponents {
  readonly graph: ComponentGraph;
  readonly registry: ComponentRegistry;
  readonly stop: () => void;
}

/**
 * Starts the live polyfill path: load the application-selected graph, lower instances, and
 * lazily import a definition's controller on its first connection. Controller failure is
 * reported after declarative output is connected and never removes that output.
 */
export async function startBrowserComponents(
  root: Document = document,
  options: Omit<BrowserLoaderOptions, "document"> = {},
): Promise<StartedBrowserComponents> {
  const loaded = await loadDocumentComponents(root, options);
  installComponentGraph(loaded.graph, root);
  const report = options.onError ?? ((error: unknown) => console.error(error));
  const nodesByTag = new Map(
    [...loaded.graph.nodes.values()].map((node) => [node.definition.contract.tag, node]),
  );
  const stop = observeDocument(root, {
    onError: report,
    onConnect(element, definition) {
      const node = nodesByTag.get(definition.contract.tag);
      if (node?.controller === undefined) return;
      let disconnected = false;
      let cleanup: void | (() => void);
      void loadController(node, options.importer)
        .then((controller) => controller(getComponentHost(element) ?? { element }))
        .then((result) => {
          if (typeof result !== "function") return;
          if (disconnected) result();
          else cleanup = result;
        })
        .catch(report);
      return () => {
        disconnected = true;
        cleanup?.();
      };
    },
  });
  return Object.freeze({ ...loaded, stop });
}
