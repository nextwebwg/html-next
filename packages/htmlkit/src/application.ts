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
import { applicationResource, pageDefinition } from "./resource.js";
import { renderHead } from "./head.js";
import type { Application, ApplicationOptions, BrowserDefinition, LoaderResult, NavigationItem, NavigationQuery, RenderedHead, RenderedPage, RouteLayer, ServerModule } from "./types.js";

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

// A classic script inlined into each document head runs before first paint, e.g. to apply a saved theme.
export async function readHeadScript(root: string): Promise<string | undefined> {
  const path = join(root, "app/head.js");
  const script = existsSync(path) ? await readFile(path, "utf8") : undefined;
  if (script !== undefined && /<!--|<\/?script/i.test(script)) {
    throw new HtmlKitError("app/head.js cannot contain <!--, <script, or </script, which would end or nest its inline script.", path);
  }
  return script;
}

// Every page gets the head script, the not-found page included, so it cannot flash either.
export function notFoundPage(headScript: string | undefined) {
  const head: RenderedHead = headScript === undefined ? { title: "Page not found" } : { title: "Page not found", script: headScript };
  const body = "<main><h1>Page not found</h1></main>";
  return { head, body, html: documentHTML(body, head) };
}

/** assets supplies a serving adapter's browser modules and stylesheets for fetch(). */
export async function createApplication(options: ApplicationOptions = {}, moduleServer?: ViteDevServer,
  assets?: (page: RenderedPage) => string): Promise<Application> {
  const config = configure(options);
  const routes = await discoverRoutes(config.root, options);
  const headScript = await readHeadScript(config.root);
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

  // Materialize entries once per application so loaders and navigation see the same catalog.
  const unenumerated: typeof routes[number][] = [];
  let catalog: Promise<ReadonlyMap<string, typeof routes[number]>> | undefined;
  const concreteRoutes = () => catalog ??= (async () => {
    const paths = new Map<string, typeof routes[number]>();
    for (const route of routes) {
      const loaded = await module(route);
      if (route.params.length > 0 && typeof loaded.entries !== "function") {
        unenumerated.push(route); continue;
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
        paths.set(path, route);
      }
    }
    return paths;
  })();
  const navigation = async (query: NavigationQuery = {}): Promise<readonly NavigationItem[]> => {
    const from = query.from ?? "/";
    if (!/^\/(?:[^/]+\/)*$/.test(from) || from.includes("[") || from.includes("?") || from.includes("#")) {
      throw new HtmlKitError("Navigation from requires a concrete application-relative directory prefix.", from);
    }
    const prefix = config.base + from.slice(1);
    const depth = from.split("/").filter(Boolean).length;
    const items = [...await concreteRoutes()].filter(([path]) => path.startsWith(prefix));
    items.sort(([a, left], [b, right]) => {
      const aParts = a.slice(config.base.length).split("/").filter(Boolean);
      const bParts = b.slice(config.base.length).split("/").filter(Boolean);
      for (let i = 0; i < Math.min(aParts.length, bParts.length); i++) {
        const aRank = left.order?.[i] ?? null;
        const bRank = right.order?.[i] ?? null;
        if (aRank !== bRank) {
          if (aRank === null) return 1;
          if (bRank === null) return -1;
          const difference = BigInt(aRank) - BigInt(bRank);
          if (difference !== 0n) return difference < 0n ? -1 : 1;
        }
        const difference = aParts[i]!.localeCompare(bParts[i]!);
        if (difference !== 0) return difference;
      }
      return aParts.length - bParts.length || a.localeCompare(b);
    });
    return Object.freeze(items.map(([href, route]) => {
      const parts = href.slice(config.base.length).split("/").filter(Boolean);
      return Object.freeze({ href, label: decodeURIComponent(parts.at(-1) ?? "Home"),
        current: href === query.current ? "page" as const : "false" as const,
        depth: parts.length - depth, pageName: route.pageName });
    }));
  };
  const application: Application = {
    ...config, routes, navigation,
    async entries() {
      const paths = await concreteRoutes();
      const missing = unenumerated[0];
      if (missing !== undefined) throw new HtmlKitError(`Static entries() must enumerate parameters: ${missing.params.join(", ")}.`, missing.server ?? missing.component);
      return [...paths.keys()].sort();
    },
    async render(pathname, signal = new AbortController().signal) {
      signal.throwIfAborted();
      const url = new URL(pathname, config.origin);
      if (url.origin !== config.origin || url.search || url.hash) throw new HtmlKitError("Static rendering requires an application pathname without a query or fragment.");
      const matched = matchRoute(routes, url.pathname, config.base);
      if (matched === undefined) {
        return { status: 404, pathname, ...notFoundPage(headScript), css: "", components: [] };
      }
      const { route, params } = matched;
      const layers = [...route.layouts, route];
      // Vite owns module caching and dependency invalidation. Per-render results never enter
      // a shared cache; HTML Next owns the DOM worker and declarative component semantics.
      const packages = new Map<string, ReturnType<typeof packageResource>>();
      const resources = new Map<string, ReturnType<typeof applicationResource>>();
      const layerURLs = new Set(layers.map(layer => pathToFileURL(layer.component).href));
      const resolveCSS = server.config.createResolver({ extensions: [".css"], mainFields: ["style"], conditions: ["style", "development|production"], preferRelative: true, tryIndex: false });
      const graph = await loadNodeComponents(layers.map(layer => pathToFileURL(layer.component).href), {
        readStylesheet: async url => ({ url, source: await readFile(fileURLToPath(url), "utf8") }),
        resolveStylesheet: async (specifier, parentURL) => {
          const resolved = await resolveCSS(specifier, fileURLToPath(parentURL));
          return resolved === undefined ? undefined
            : pathToFileURL(resolved.replace(/[?#].*$/, "")).href + (/[?#].*$/.exec(resolved)?.[0] ?? "");
        },
        stylesheetAssetURL: url => url.startsWith("file:") ? `/@fs/${fileURLToPath(url)}${new URL(url).search}${new URL(url).hash}` : url,
        // The graph resolver is synchronous. Prepare its bare imports while asynchronously
        // reading each carrier, using Vite's ESM resolution from the consuming application.
        readComponent: async (url) => {
          const source = await readFile(fileURLToPath(url), "utf8");
          const parsed = layerURLs.has(url) ? applicationResource(source, url) : parseComponentResource(source, url);
          if ("configuration" in parsed) resources.set(url, parsed);
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
        if (layer === route) return pageDefinition(resources.get(pathToFileURL(layer.component).href)!, layer.component);
        const roots = graph.roots.filter(id => graph.nodes.get(id)!.url === pathToFileURL(layer.component).href);
        if (roots.length !== 1) throw new HtmlKitError("A page or layout must declare exactly one root component.", layer.component);
        return graph.nodes.get(roots[0]!)!.definition;
      });
      if (layerDefinitions.at(-1)!.contract.tag !== route.pageName) {
        throw new HtmlKitError("Page component name changed; rediscover routes before rendering.", route.component);
      }
      for (const definition of layerDefinitions.slice(0, -1)) {
        if (!definition.slots?.some(slot => slot.name === "page")) throw new HtmlKitError('Layout requires a slot named "page".', definition.source.file);
      }
      const results: LoaderResult[] = [];
      let parent: Readonly<Record<string, unknown>> = Object.freeze({});
      let head: RenderedHead = {};
      for (const layer of layers) {
        signal.throwIfAborted();
        const loaded = await module(layer);
        const context = { phase: "prerender" as const, url: new URL(url), base: config.base, params, parent,
          fetch: globalThis.fetch, signal, navigation: (query?: NavigationQuery) => navigation({ current: url.pathname, ...query }),
          get request(): Request { throw new HtmlKitError("request is unavailable during static generation.", layer.server); } };
        const result = loaded.load === undefined ? {} : await loaded.load(context);
        if (result === null || typeof result !== "object" || Array.isArray(result)) throw new HtmlKitError("load() must return a LoaderResult object.", layer.server);
        results.push(result);
        parent = Object.freeze({ ...parent, ...result.data });
        const index = results.length - 1;
        head = await renderHead(resources.get(pathToFileURL(layer.component).href)!, layerDefinitions[index]!, result, head, url.href,
          (definition, values) => invocation(definition, values, "htmlkit-head", "", false));
      }
      if (headScript !== undefined) head = { ...head, script: headScript };
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
    // Not a method of `this`: runtimes are handed the function itself, as in Deno.serve(application.fetch).
    async fetch(request) {
      if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405, headers: { allow: "GET, HEAD" } });
      const { pathname } = new URL(request.url);
      // A path starting with // names another origin to render(), which rejects it; no page lives there.
      const page = pathname.startsWith("//") ? { status: 404 as const, pathname, ...notFoundPage(headScript), css: "", components: [] }
        : await application.render(pathname, request.signal);
      if (page.status === 200 && !pathname.endsWith("/")) return new Response(null, { status: 308, headers: { location: pathname + "/" } });
      return new Response(request.method === "HEAD" ? null : documentHTML(page.body, page.head, assets?.(page)),
        { status: page.status, headers: { "content-type": "text/html; charset=utf-8" } });
    },
    async close() { if (ownsServer) await server.close(); },
  };
  return application;
}
