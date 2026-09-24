import { buildComponentGraph, type ComponentGraph } from "./graph.js";
import { ComponentRegistry } from "./registry.js";
import { ResourceResolver, type ImportMapLike } from "./resolve.js";
import { loadController, loadControllerModule, type ModuleImporter } from "./controller.js";
import { parseBrowserComponent, parseBrowserComponentResource } from "./browser-source.js";
import {
  getComponentHost,
  installComponentGraph,
  installInlineDefinitionParser,
  observeDocument,
  setControllerModule,
} from "./runtime.js";

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
  for (const script of root.querySelectorAll('script[type="importmap"]')) {
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
  const resolver = new ResourceResolver(
    options.importMap ?? readImportMap(root),
    root.baseURI,
    root.URL,
  );
  const graph = await buildComponentGraph(rootSpecifiers, {
    resolver,
    fetchComponent: async (url) => {
      const response = await request(url);
      if (!response.ok) throw new TypeError(`Component request \`${url}\` failed with ${response.status}.`);
      return { url: response.url || url, source: await response.text() };
    },
    parseComponentResource: (sourceText, source) =>
      parseBrowserComponentResource(sourceText, source, root),
    isCustomElementRegistered: (tag) => root.defaultView?.customElements.get(tag) !== undefined,
  });
  const registry = options.registry ?? new ComponentRegistry();
  registry.addGraph(graph, (node) => loadController(node, options.importer));
  return Object.freeze({ graph, registry });
}

/** Reads the application's direct live roots from link[rel=component]. */
export function documentComponentRoots(root: Document = document): readonly string[] {
  return Object.freeze(Array.from(
    root.querySelectorAll('link[rel="component"][href]'),
    (link) => link.getAttribute("href")!,
  ).filter((href) => href.trim() !== ""));
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
  // The live delivery discovers definitions authored in the page, so teach the runtime to read
  // them. A build-time graph imports the runtime directly and never carries the parser.
  installInlineDefinitionParser(parseBrowserComponent);
  const loaded = await loadDocumentComponents(root, options);
  installComponentGraph(loaded.graph, root);
  const report = options.onError ?? ((error: unknown) => console.error(error));
  const stop = observeDocument(root, {
    onError: report,
    onConnect(element, definition) {
      const node = loaded.registry.get(definition.contract.tag)?.node;
      if (node?.controller === undefined) return;
      const module = loadControllerModule(node, options.importer);
      setControllerModule(element, module);
      let disconnected = false;
      let cleanup: void | (() => void);
      void module
        // A module import may outlive the connection that requested it. Reconnection starts a
        // fresh lifecycle attempt; invoking this stale one would duplicate controller work and
        // let asynchronous setup attach owners to an already disconnected instance.
        .then((loaded) => disconnected ? undefined : loaded.default(getComponentHost(element)!))
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
