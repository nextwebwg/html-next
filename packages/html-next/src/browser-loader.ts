import { buildComponentGraph, type ComponentGraph } from "./graph.js";
import { ComponentRegistry } from "./registry.js";
import { ResourceResolver, type ImportMapLike } from "./resolve.js";
import { loadController, loadControllerModule, type ModuleImporter } from "./controller.js";
import { parseBrowserComponent, parseBrowserComponentResource } from "./browser-source.js";
import { createStylesheetLoader } from "./stylesheet-resources.js";
import { parseStylesheetInBrowser } from "./stylesheet-resources-browser.js";
import {
  getComponentHost,
  installComponentGraph,
  installInlineDefinitionParser,
  registerComponentDefinitions,
  lowerDocument,
  observeDocument,
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
  return loadWithStylesheets(rootSpecifiers, options);
}

async function loadWithStylesheets(
  rootSpecifiers: readonly string[],
  options: BrowserLoaderOptions,
  stylesheetLoader?: ReturnType<typeof createStylesheetLoader>,
): Promise<{ readonly graph: ComponentGraph; readonly registry: ComponentRegistry }> {
  const root = options.document ?? document;
  const request = options.fetch ?? fetch;
  const resolver = new ResourceResolver(
    options.importMap ?? readImportMap(root),
    root.baseURI,
    root.URL,
  );
  const fetchResource = async (url: string): Promise<{ url: string; source: string }> => {
      const response = await request(url);
      if (!response.ok) throw new TypeError(`Component request \`${url}\` failed with ${response.status}.`);
      return { url: response.url || url, source: await response.text() };
  };
  const styles = stylesheetLoader ?? createStylesheetLoader({
    parse: css => parseStylesheetInBrowser(css, root), fetch: fetchResource,
    resolve: (specifier, parent) => resolver.resolveDependency(new URL(specifier, parent.url).href, parent.url, parent.trustRoot),
    assertFinalURL: (resource, finalURL) => resolver.assertFinalURL(resource, finalURL),
    supports: condition => (root.defaultView ?? globalThis).CSS.supports(`(${condition})`),
  });
  const graph = await buildComponentGraph(rootSpecifiers, {
    resolver,
    fetchComponent: fetchResource,
    prepareStyles: styles.prepare,
    parseComponentResource: (sourceText, source) =>
      parseBrowserComponentResource(sourceText, source, root),
    isCustomElementRegistered: (tag) => root.defaultView?.customElements.get(tag) !== undefined,
  });
  const registry = options.registry ?? new ComponentRegistry();
  registry.addGraph(graph, (node) => loadController(node, options.importer));
  return Object.freeze({ graph, registry });
}

const componentLinkSelector = 'link[rel="component"][href]';

/** Reads the application's direct live roots from link[rel=component]. */
export function documentComponentRoots(root: Document = document): readonly string[] {
  return Object.freeze(Array.from(
    root.querySelectorAll(componentLinkSelector),
    (link) => link.getAttribute("href")!,
  ).filter((href) => href.trim() !== ""));
}

export interface StartedBrowserComponents {
  readonly graph: ComponentGraph;
  readonly registry: ComponentRegistry;
  readonly stop: () => void;
}

/**
 * Starts the live polyfill path: load the application-selected graph, lower instances, and
 * lazily import a definition's controller on its first connection. Controller failure is
 * reported after declarative output is connected and never removes that output. A component
 * link added later loads its graph into the running page.
 */
export async function startBrowserComponents(
  root: Document = document,
  options: Omit<BrowserLoaderOptions, "document"> = {},
): Promise<StartedBrowserComponents> {
  // The live delivery discovers definitions authored in the page, so teach the runtime to read
  // them. A build-time graph imports the runtime directly and never carries the parser.
  const resolver = new ResourceResolver(options.importMap ?? readImportMap(root), root.baseURI, root.URL);
  const styles = createStylesheetLoader({
    parse: css => parseStylesheetInBrowser(css, root),
    fetch: async url => {
      const response = await (options.fetch ?? fetch)(url);
      if (!response.ok) throw new TypeError(`Stylesheet request failed with ${response.status}.`);
      return { url: response.url || url, source: await response.text() };
    },
    resolve: (specifier, parent) => resolver.resolveDependency(new URL(specifier, parent.url).href, parent.url, parent.trustRoot),
    assertFinalURL: (resource, finalURL) => resolver.assertFinalURL(resource, finalURL),
    supports: condition => (root.defaultView ?? globalThis).CSS.supports(`(${condition})`),
  });
  const prepared = new WeakMap<Element, import("./template.js").ComponentDefinition>();
  const pending = new WeakMap<Element, Promise<void>>();
  installInlineDefinitionParser((carrier, source) => prepared.get(carrier) ??
    (pending.has(carrier) ? undefined : parseBrowserComponent(carrier, source)));
  const prepareInline = (carrier: Element): Promise<void> => {
    const existing = pending.get(carrier);
    if (existing !== undefined) return existing;
    const preparation = (async () => {
      const definition = parseBrowserComponent(carrier, root.baseURI);
      const resource = resolver.resolveRoot(root.baseURI);
      prepared.set(carrier, await styles.prepare(definition, resource));
    })();
    pending.set(carrier, preparation);
    return preparation;
  };
  const requested = new Set(documentComponentRoots(root));
  const loaded = await loadWithStylesheets([...requested], { ...options, document: root }, styles);
  for (const carrier of root.querySelectorAll("template[component]")) await prepareInline(carrier);
  installComponentGraph(loaded.graph, root);
  const report = options.onError ?? ((error: unknown) => console.error(error));
  let stopped = false;
  let extensions = Promise.resolve();
  const initialized = new WeakSet<object>();
  // A later root may share dependencies with the installed graph; only its new definitions are
  // added. Installing them renders the instances already waiting in the document.
  const addRoot = (href: string | null): void => {
    if (href === null || href.trim() === "" || requested.has(href)) return;
    requested.add(href);
    extensions = extensions.then(() => loadWithStylesheets([href], { ...options, document: root }, styles))
      .then(({ graph }) => {
        if (stopped) return;
        const nodes = new Map(Array.from(graph.nodes).filter(
          ([, node]) => loaded.registry.get(node.definition.contract.tag) === undefined,
        ));
        const added = { ...graph, nodes };
        loaded.registry.addGraph(added, (node) => loadController(node, options.importer));
        installComponentGraph(added, root);
      })
      .catch(report);
  };
  const stopObserving = observeDocument(root, {
    onError: report,
    onAdded(element) {
      const carriers = [...(element.matches("template[component]") ? [element] : []), ...element.querySelectorAll("template[component]")];
      for (const carrier of carriers) {
        const ready = prepareInline(carrier).then(() => true, error => { report(error); return false; });
        extensions = extensions.then(async () => {
          if (!await ready) return;
          if (stopped || !carrier.isConnected) return;
          registerComponentDefinitions([prepared.get(carrier)!], root);
          carrier.remove();
          lowerDocument(root);
        }).catch(report);
      }
      if (element.matches(componentLinkSelector)) addRoot(element.getAttribute("href"));
      for (const link of element.querySelectorAll(componentLinkSelector)) addRoot(link.getAttribute("href"));
    },
    onConnect(element, definition) {
      const node = loaded.registry.get(definition.contract.tag)?.node;
      if (node?.controller === undefined) return;
      const module = loadControllerModule(node, options.importer);
      let disconnected = false;
      let cleanup: void | (() => void);
      void module
        // A module import may outlive the connection that requested it. Reconnection starts a
        // fresh lifecycle attempt; invoking this stale one would duplicate controller work and
        // let asynchronous setup attach owners to an already disconnected instance.
        .then((loaded) => {
          if (disconnected) return;
          const host = getComponentHost(element)!;
          if (initialized.has(host)) return;
          initialized.add(host);
          return loaded.default(host);
        })
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
  // Links added while the initial graph loaded, before observation began.
  for (const href of documentComponentRoots(root)) addRoot(href);
  const stop = (): void => {
    stopped = true;
    stopObserving();
  };
  return Object.freeze({ ...loaded, stop });
}
