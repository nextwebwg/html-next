import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

import { compileComponentStylesForBuild, parseComponentResource, serializePropTarget, serializeTypedValue, type ComponentDefinition } from "@nextwebwg/html-next";
import { loadNodeComponents } from "@nextwebwg/html-next/node-loader";
import { renderComponents } from "@nextwebwg/html-next/server";
import { createServer, isRunnableDevEnvironment, type ViteDevServer } from "vite";

import { configure, HtmlKitError } from "./config.js";
import { documentHTML, escapeHTML } from "./document.js";
import { discoverRoutes, matchRoute, parameter, validSegment } from "./routes.js";
import type { Application, ApplicationOptions, BrowserDefinition, LoaderResult, PageHead, RouteLayer, ServerModule } from "./types.js";

function invocation(definition: ComponentDefinition, result: LoaderResult, id: string, child: string, nested: boolean): string {
  const props = result.props ?? {};
  for (const name of Object.keys(props)) {
    if (!Object.hasOwn(definition.contract.props, name)) throw new HtmlKitError(`Undeclared prop ${name}.`, definition.source.file);
  }
  let attributes = ` id="${id}"${nested ? ' slot="page"' : ""}`;
  for (const [name, contract] of Object.entries(definition.contract.props)) {
    serializePropTarget(contract, props[name]);
    // The contract target describes lowering onto native DOM. Invocation attributes carry
    // the public prop name; writing the target name here silently loses remapped props.
    const provided = props[name] === undefined ? contract.default : props[name];
    const value = provided == null ? null : serializeTypedValue(provided, contract.type);
    const attribute = name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
    if (value !== null) attributes += ` ${attribute}="${escapeHTML(value)}"`;
  }
  const tag = definition.contract.tag;
  return `<${tag}${attributes}>${child}</${tag}>`;
}

function packageResource(path: string) {
  let directory = dirname(path);
  while (!existsSync(join(directory, "package.json")) && dirname(directory) !== directory) directory = dirname(directory);
  return { url: pathToFileURL(path).href, trustRoot: pathToFileURL(directory + "/").href };
}

export async function createApplication(options: ApplicationOptions = {}, moduleServer?: ViteDevServer): Promise<Application> {
  const config = configure(options);
  const routes = await discoverRoutes(config.root, options);
  const ownsServer = moduleServer === undefined;
  const server = moduleServer ?? await createServer({ root: config.root, configFile: false, appType: "custom",
    mode: "development", publicDir: false, server: { middlewareMode: true, watch: null, hmr: false },
    optimizeDeps: { noDiscovery: true, include: [] }, logLevel: "silent" });
  const environment = server.environments.ssr;
  if (environment === undefined || !isRunnableDevEnvironment(environment)) {
    if (ownsServer) await server.close();
    throw new HtmlKitError("Vite requires a runnable Node loader environment.");
  }
  const module = async (layer: RouteLayer): Promise<ServerModule> => layer.server === undefined ? {} :
    await environment.runner.import(layer.server) as ServerModule;

  return {
    ...config, routes,
    async entries() {
      const paths = new Set<string>();
      for (const route of routes) {
        const loaded = await module(route);
        if (route.params.length > 0 && typeof loaded.entries !== "function") {
          throw new HtmlKitError(`Static entries() must enumerate parameters: ${route.params.join(", ")}.`, route.server ?? route.component);
        }
        const entries = loaded.entries === undefined ? [{}] : await loaded.entries();
        if (!Array.isArray(entries) || entries.length === 0) throw new HtmlKitError("entries() must return a nonempty array.", route.server);
        for (const entry of entries) {
          if (entry === null || typeof entry !== "object" || Object.keys(entry).sort().join(",") !== [...route.params].sort().join(",")) {
            throw new HtmlKitError(`Each entry must provide exactly these parameters: ${route.params.join(", ")}.`, route.server);
          }
          const segments = route.segments.map(segment => {
            const name = parameter(segment);
            if (name === undefined) return segment;
            const value: unknown = entry[name];
            if (!validSegment(value)) throw new HtmlKitError(`Parameter ${name} must be a safe nonempty URL segment.`, route.server);
            return encodeURIComponent(value);
          });
          const path = config.base + (segments.length === 0 ? "" : segments.join("/") + "/");
          if (paths.has(path)) throw new HtmlKitError(`Static route collision at ${path}.`, route.component);
          const matched = matchRoute(routes, path, config.base);
          if (matched?.route !== route) throw new HtmlKitError(`Static route collision with ${matched?.route.pattern} at ${path}.`, route.component);
          paths.add(path);
        }
      }
      return [...paths].sort();
    },
    async render(pathname, signal = new AbortController().signal) {
      signal.throwIfAborted();
      const url = new URL(pathname, config.origin);
      if (url.origin !== config.origin || url.search || url.hash) throw new HtmlKitError("Static rendering requires an application pathname without a query or fragment.");
      const matched = matchRoute(routes, url.pathname, config.base);
      if (matched === undefined) {
        const head = { title: "Page not found" };
        const body = '<main><h1>Page not found</h1></main>';
        return { status: 404, pathname, html: documentHTML(body, head), css: "", head, body, components: [] };
      }
      const { route, params } = matched;
      const layers = [...route.layouts, route];
      // Vite owns module caching and dependency invalidation. Per-render results never enter
      // a shared cache; HTML Next owns the DOM worker and declarative component semantics.
      const packages = new Map<string, ReturnType<typeof packageResource>>();
      const graph = await loadNodeComponents(layers.map(layer => pathToFileURL(layer.component).href), {
        // The graph resolver is synchronous. Prepare its bare imports while asynchronously
        // reading each carrier, using Vite's ESM resolution from the consuming application.
        readComponent: async (url) => {
          const source = await readFile(fileURLToPath(url), "utf8");
          const parsed = parseComponentResource(source, url);
          const imports = [...parsed.dependencies, ...parsed.definitions.flatMap(definition => definition.controller === undefined ? [] : [definition.controller])];
          for (const specifier of imports) {
            if (/^(?:[A-Za-z][A-Za-z\d+.-]*:|\/|\.\.?\/)/.test(specifier)) continue;
            const resolved = await server.environments.client!.pluginContainer.resolveId(specifier, fileURLToPath(url));
            if (resolved === null || resolved.external) throw new HtmlKitError(`Cannot resolve component import ${specifier}.`, url);
            packages.set(`${url}\0${specifier}`, packageResource(resolved.id));
          }
          return { url, source };
        },
        resolvePackage: (specifier, parentURL) => {
          const resolved = packages.get(`${parentURL}\0${specifier}`);
          if (resolved === undefined) throw new HtmlKitError(`Cannot resolve component import ${specifier}.`, parentURL);
          return resolved;
        },
      });
      const layerDefinitions = layers.map(layer => {
        const roots = graph.roots.filter(id => graph.nodes.get(id)!.url === pathToFileURL(layer.component).href);
        if (roots.length !== 1) throw new HtmlKitError("A page or layout must declare exactly one root component.", layer.component);
        return graph.nodes.get(roots[0]!)!.definition;
      });
      for (const definition of layerDefinitions.slice(0, -1)) {
        if (!definition.slots?.some(slot => slot.name === "page")) throw new HtmlKitError('Layout requires a slot named "page".', definition.source.file);
      }
      const results: LoaderResult[] = [];
      let parent: Readonly<Record<string, unknown>> = Object.freeze({});
      let head: PageHead = {};
      for (const layer of layers) {
        signal.throwIfAborted();
        const loaded = await module(layer);
        const context = { phase: "prerender" as const, url: new URL(url), base: config.base, params, parent,
          fetch: globalThis.fetch, signal,
          get request(): Request { throw new HtmlKitError("request is unavailable during static generation.", layer.server); } };
        const result = loaded.load === undefined ? {} : await loaded.load(context);
        if (result === null || typeof result !== "object" || Array.isArray(result)) throw new HtmlKitError("load() must return a LoaderResult object.", layer.server);
        results.push(result);
        parent = Object.freeze({ ...parent, ...result.data });
        head = { ...head, ...result.head };
      }
      const state: Record<string, Readonly<Record<string, unknown>>> = {};
      let body = "";
      for (let i = layers.length - 1; i >= 0; i--) {
        const id = `htmlkit-layer-${i}`;
        const result = results[i]!;
        if (result.state !== undefined) state[`#${id}`] = result.state;
        body = invocation(layerDefinitions[i]!, result, id, body, i > 0);
      }
      const components: BrowserDefinition[] = [...graph.nodes.values()].map(node => ({ definition: node.definition,
        styles: compileComponentStylesForBuild(node.definition.css, node.definition),
        ...(node.controller === undefined ? {} : { controller: fileURLToPath(node.controller.url) }) }));
      const rendered = await renderComponents(body, { definitions: components.map(value => value.definition), url: url.href, state });
      signal.throwIfAborted();
      return { status: 200, pathname: url.pathname, body: rendered.html, css: rendered.css, head,
        html: documentHTML(rendered.html, head), components };
    },
    async close() { if (ownsServer) await server.close(); },
  };
}
