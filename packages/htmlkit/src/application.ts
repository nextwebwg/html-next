import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

import { compileComponentStylesForBuild, parseComponentResource, serializePropTarget, serializeTypedValue, type ComponentDefinition } from "@nextwebwg/html-next";
import { loadNodeComponents } from "@nextwebwg/html-next/node-loader";
import { renderComponents } from "@nextwebwg/html-next/server";
import { createServer, isRunnableDevEnvironment, type ViteDevServer } from "vite";

import { configure, HtmlKitError, rootAlias, withPlugins } from "./config.js";
import { documentHTML, escapeHTML, pagePayload, payloadPath, redirectPage, type PageAssets } from "./document.js";
import { breadth, discover, matchRoute, parameter, redirectLocation, redirectStatuses, redirectTable, validSegment } from "./routes.js";
import { applicationResource, pageDefinition } from "./resource.js";
import { renderHead } from "./head.js";
import type { Application, ApplicationOptions, ApplicationRoute, BrowserDefinition, LoaderResult, NavigationItem, NavigationNode, NavigationQuery, PagerLinks, RedirectStatus, RenderedHead, RenderedLayer, RenderedPage, RouteLayer, ServerModule } from "./types.js";

/** What a loader's redirect() throws, so render answers with the redirect instead of the page. */
class Redirect {
  constructor(readonly location: string, readonly status: RedirectStatus) {}
}

/** A loader's props as invocation attributes, in their HTML form, defaults included. */
function invocationAttributes(definition: ComponentDefinition, result: LoaderResult): Record<string, string> {
  const props = result.props ?? {};
  for (const name of Object.keys(props)) {
    if (!Object.hasOwn(definition.contract.props, name)) throw new HtmlKitError(`Undeclared prop ${name}.`, definition.source.file);
  }
  const attributes: Record<string, string> = {};
  for (const [name, contract] of Object.entries(definition.contract.props)) {
    serializePropTarget(contract, props[name], name, definition.contract.tag);
    // The contract target describes lowering onto native DOM. Invocation attributes carry
    // the public prop name; writing the target name here silently loses remapped props.
    const provided = props[name] === undefined ? contract.default : props[name];
    const value = provided == null ? null : serializeTypedValue(provided, contract.type);
    if (value !== null) attributes[name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase()] = value;
  }
  return attributes;
}

/** The browser builds the same invocation from a page payload (client.ts). */
function invocation(tag: string, attributes: Readonly<Record<string, string>>, id: string, child: string, nested: boolean): string {
  return `<${tag} id="${id}"${nested ? ' slot="page"' : ""}${Object.entries(attributes).map(([name, value]) => ` ${name}="${escapeHTML(value)}"`).join("")}>${child}</${tag}>`;
}

// Built-in components need no link: a resource that uses one gets it added after its content, so
// diagnostics keep their line numbers. The import map below resolves it from this package.
const builtins = [["hk-nav", "@nextwebwg/htmlkit/components/nav.html"], ["hk-breadcrumbs", "@nextwebwg/htmlkit/components/breadcrumbs.html"],
  ["hk-pager", "@nextwebwg/htmlkit/components/pager.html"]] as const;

/** HTMLKit's import map: @/ is the project root, as in Nuxt, and built-ins resolve from this package. */
function importMap(root: string) {
  return { imports: { "@/": pathToFileURL(root).href + "/", "@nextwebwg/htmlkit/components/": new URL("../components/", import.meta.url).href } };
}

function packageResource(path: string) {
  let directory = dirname(path);
  while (!existsSync(join(directory, "package.json")) && dirname(directory) !== directory) directory = dirname(directory);
  return { url: pathToFileURL(path).href, trustRoot: pathToFileURL(directory + "/").href };
}

// Classic scripts inlined into each document head run before first paint, e.g. to apply a saved theme:
// a plugin's headScript, then app/head.js, each in its own element so neither can break the other.
export async function headScripts(options: ApplicationOptions, root: string): Promise<readonly string[]> {
  const path = join(root, "app/head.js");
  const file = existsSync(path) ? await readFile(path, "utf8") : undefined;
  const scripts: string[] = [];
  for (const [script, name, source] of [[options.headScript, "headScript", undefined], [file, "app/head.js", path]] as const) {
    if (script === undefined) continue;
    if (/<!--|<\/?script/i.test(script)) {
      throw new HtmlKitError(`${name} cannot contain <!--, <script, or </script, which would end or nest its inline script.`, source);
    }
    scripts.push(script);
  }
  return scripts;
}

// Every page gets the head scripts, the not-found page included, so it cannot flash either.
export function notFoundPage(scripts: readonly string[]) {
  const head: RenderedHead = { title: "Page not found", scripts };
  const body = "<main><h1>Page not found</h1></main>";
  return { head, body, html: documentHTML(body, head) };
}

/** What app/error.html receives: the status and its standard reason phrase, never the error itself. */
interface Failure { readonly status: 500; readonly message: string }

/** The page for a failure without app/error.html, or when it fails too. */
function errorPage({ status, message }: Failure, pathname: string, scripts: readonly string[]): RenderedPage {
  const head: RenderedHead = { title: message, scripts };
  const body = `<main><h1>${escapeHTML(message)}</h1></main>`;
  return { status, pathname, head, body, html: documentHTML(body, head), css: "", components: [], layers: [] };
}

/** assets supplies a serving adapter's browser modules and stylesheets for fetch(). */
export async function createApplication(input: ApplicationOptions = {}, moduleServer?: ViteDevServer,
  assets?: (page: RenderedPage) => PageAssets): Promise<Application> {
  const options = await withPlugins(input);
  const config = configure(options);
  const redirects = redirectTable(config.base, options.redirects);
  const { routes, notFound: notFoundRoute, error: errorRoute, sources, files, watched } = await discover(config.root, { ...options, base: config.base });
  // A dynamic page's entries are checked the same way when they are listed.
  const shadowed = routes.find(route => route.params.length === 0 && redirects.has(config.base + route.pattern.slice(1)));
  if (shadowed !== undefined) throw new HtmlKitError(`The redirects option also redirects ${shadowed.pattern}, which is this page's URL.`, shadowed.component);
  const scripts = await headScripts(options, config.root);
  const ownsServer = moduleServer === undefined;
  const map = importMap(config.root);
  const server = moduleServer ?? await createServer({ root: config.root, configFile: false, appType: "custom", resolve: { alias: rootAlias(config.root) },
    mode: "development", publicDir: false, server: { middlewareMode: true, watch: null, hmr: false },
    optimizeDeps: { noDiscovery: true, include: [] }, logLevel: "silent" });
  const environment = server.environments.ssr;
  if (environment === undefined || !isRunnableDevEnvironment(environment)) {
    if (ownsServer) await server.close();
    throw new HtmlKitError("Vite requires a runnable Node loader environment.");
  }
  const module = async (layer: RouteLayer): Promise<ServerModule> => layer.server === undefined ? {} :
    typeof layer.server === "string" ? await environment.runner.import(layer.server) as ServerModule : layer.server;
  // Diagnostics name a loader's file, or its component when a plugin supplies the loader module.
  const origin = (layer: RouteLayer): string => typeof layer.server === "string" ? layer.server : layer.component;

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
      if (!Array.isArray(entries) || entries.length === 0) throw new HtmlKitError("entries() must return a nonempty array.", origin(route));
      for (const entry of entries) {
        if (entry === null || typeof entry !== "object" || Object.keys(entry).sort().join(",") !== [...route.params].sort().join(",")) {
          throw new HtmlKitError(`Each entry must provide exactly these parameters: ${route.params.join(", ")}.`, origin(route));
        }
        const segments = route.segments.flatMap(segment => {
          const name = parameter(segment);
          if (name === undefined) return [segment];
          const value: unknown = entry[name];
          if (breadth(segment) === 1) {
            if (!validSegment(value)) throw new HtmlKitError(`Parameter ${name} must be a safe nonempty URL segment.`, origin(route));
            return [encodeURIComponent(value)];
          }
          // [...name] takes at least one segment and [[...name]] any number, as a list.
          if (!Array.isArray(value) || !value.every(validSegment) || (value.length === 0 && breadth(segment) === 2)) {
            throw new HtmlKitError(`Parameter ${name} must be a ${breadth(segment) === 2 ? "nonempty " : ""}list of safe nonempty URL segments.`, origin(route));
          }
          return value.map(encodeURIComponent);
        });
        const path = config.base + (segments.length === 0 ? "" : segments.join("/") + "/");
        if (paths.has(path)) throw new HtmlKitError(`Static route collision at ${path}.`, route.component);
        if (redirects.has(path)) throw new HtmlKitError(`The redirects option also redirects ${path}, which is this page's URL.`, route.component);
        const matched = matchRoute(routes, path, config.base);
        if (matched?.route !== route) throw new HtmlKitError(`Static route collision with ${matched?.route.pattern} at ${path}.`, route.component);
        paths.set(path, route);
      }
    }
    return paths;
  })();
  const checkedFrom = (from = "/"): string => {
    if (!/^\/(?:[^/]+\/)*$/.test(from) || from.includes("[") || from.includes("?") || from.includes("#")) {
      throw new HtmlKitError("Navigation from requires a concrete application-relative directory prefix.", from);
    }
    return from;
  };
  const item = (href: string, route: ApplicationRoute, depth: number, current: string | undefined): NavigationItem => Object.freeze({
    href, label: route.label ?? decodeURIComponent(href.slice(config.base.length).split("/").filter(Boolean).at(-1) ?? "Home"),
    current: href === current ? "page" as const : "false" as const, depth, pageName: route.pageName,
    ...(route.groups === undefined ? {} : { group: route.groups.at(-1)!.label }) });
  // A page's place in the file tree: each URL segment, with its (group) folders where they sit.
  // depth is the URL segments above the element: a segment's index, or a group's depth.
  const treePath = (href: string, route: ApplicationRoute) => {
    const path: { name: string; rank: string | null; depth: number; group?: true }[] = href.slice(config.base.length).split("/").filter(Boolean)
      .map((name, i) => ({ name, rank: route.order?.[i] ?? null, depth: i }));
    // Deepest first, so each insertion index is still a count of URL segments.
    for (const group of (route.groups ?? []).toReversed()) path.splice(group.depth, 0, { name: group.label, rank: group.order, depth: group.depth, group: true });
    return path;
  };
  const navigation = async (query: NavigationQuery = {}): Promise<readonly NavigationItem[]> => {
    const from = checkedFrom(query.from);
    const prefix = config.base + from.slice(1);
    const depth = from.split("/").filter(Boolean).length;
    // Hidden pages and alias routes stay routable but out of navigation.
    const items = [...await concreteRoutes()].filter(([path, route]) => path.startsWith(prefix) && !route.hidden && route.canonical === undefined);
    const paths = new Map(items.map(([href, route]) => [href, treePath(href, route)]));
    items.sort(([a], [b]) => {
      const aParts = paths.get(a)!;
      const bParts = paths.get(b)!;
      for (let i = 0; i < Math.min(aParts.length, bParts.length); i++) {
        const aRank = aParts[i]!.rank;
        const bRank = bParts[i]!.rank;
        if (aRank !== bRank) {
          if (aRank === null) return 1;
          if (bRank === null) return -1;
          const difference = BigInt(aRank) - BigInt(bRank);
          if (difference !== 0n) return difference < 0n ? -1 : 1;
        }
        const difference = aParts[i]!.name.localeCompare(bParts[i]!.name);
        if (difference !== 0) return difference;
      }
      return aParts.length - bParts.length || a.localeCompare(b);
    });
    return Object.freeze(items.map(([href, route]) => item(href, route, href.slice(config.base.length).split("/").filter(Boolean).length - depth, query.current)));
  };
  // Each existing page from `from` down to the current one, by URL; the current page is included even when hidden.
  const breadcrumbs = async (query: NavigationQuery = {}): Promise<readonly NavigationItem[]> => {
    const from = checkedFrom(query.from);
    const current = query.current;
    if (current === undefined || !current.startsWith(config.base + from.slice(1))) return Object.freeze([]);
    const paths = await concreteRoutes();
    const parts = current.slice(config.base.length).split("/").filter(Boolean);
    const start = from.split("/").filter(Boolean).length;
    const trail: NavigationItem[] = [];
    for (let i = start; i <= parts.length; i++) {
      const href = config.base + parts.slice(0, i).map(part => part + "/").join("");
      // The page being rendered exists even when no entries() lists it, as for a dynamic page at request time.
      const route = paths.get(href) ?? (i === parts.length ? matchRoute(routes, href, config.base)?.route : undefined);
      if (route !== undefined && route.canonical === undefined) trail.push(item(href, route, i - start, current));
    }
    return Object.freeze(trail);
  };
  // navigation()'s pages, which come in tree order, nested under the folders and groups below `from`.
  const navigationTree = async (query: NavigationQuery = {}): Promise<readonly NavigationNode[]> => {
    const items = await navigation(query);
    const paths = await concreteRoutes();
    const fromDepth = checkedFrom(query.from).split("/").filter(Boolean).length;
    type Draft = { label: string; order: string | null; children: Draft[]; item?: NavigationItem; route?: ApplicationRoute };
    const top: Draft[] = [];
    const nodes = new Map<string, Draft>();
    for (const item of items) {
      const route = paths.get(item.href)!;
      let siblings = top;
      let key = "";
      let node: Draft | undefined;
      // The page's own node is the last element below `from`; `from`'s index page is a top node of its own.
      for (const element of treePath(item.href, route).filter(element => element.depth >= fromDepth)) {
        key += `${element.group ? "(" : "/"}${element.name}\0`;
        node = nodes.get(key);
        if (node === undefined) {
          node = { label: element.group ? element.name : decodeURIComponent(element.name), order: element.rank, children: [] };
          nodes.set(key, node);
          siblings.push(node);
        }
        siblings = node.children;
      }
      if (node === undefined) { node = { label: item.label, order: null, children: [] }; top.unshift(node); }
      node.item = item;
      node.route = route;
    }
    const finish = (draft: Draft, depth: number): NavigationNode => {
      const children = draft.children.map(child => finish(child, depth + 1));
      const { item, route } = draft;
      // A folder's index page labels the folder, by hk:label, then its <title>.
      const label = item === undefined ? draft.label : children.length > 0 && route!.label === undefined ? route!.title ?? draft.label : item.label;
      const current = item?.current ?? "false";
      return Object.freeze({ label, ...(item === undefined ? {} : { href: item.href, pageName: item.pageName }), current,
        open: current === "page" || children.some(child => child.open), depth, order: draft.order, children: Object.freeze(children) });
    };
    return Object.freeze(top.map(draft => finish(draft, 0)));
  };
  // The neighbours of the current page in navigation order.
  const pager = async (query: NavigationQuery = {}): Promise<PagerLinks> => {
    const items = await navigation(query);
    const index = items.findIndex(entry => entry.current === "page");
    if (index < 0) return Object.freeze({});
    return Object.freeze({ ...(index > 0 ? { previous: items[index - 1]! } : {}), ...(index < items.length - 1 ? { next: items[index + 1]! } : {}) });
  };
  const application: Application = {
    ...config, routes, ...(notFoundRoute === undefined ? {} : { notFound: notFoundRoute }), ...(errorRoute === undefined ? {} : { error: errorRoute }), navigation, navigationTree, files, watchFiles: watched,
    async entries() {
      const paths = await concreteRoutes();
      const missing = unenumerated[0];
      if (missing !== undefined) throw new HtmlKitError(`Static entries() must enumerate parameters: ${missing.params.join(", ")}.`, origin(missing));
      return [...paths.keys()].sort();
    },
    async render(pathname, signal = new AbortController().signal, failure?: Failure) {
      signal.throwIfAborted();
      const notFound = () => ({ status: 404 as const, pathname, ...notFoundPage(scripts), css: "", components: [], layers: [] });
      // A path starting with // would name another origin; no page lives there, for documents or payloads.
      if (pathname.startsWith("//")) return notFound();
      const url = new URL(pathname, config.origin);
      if (url.origin !== config.origin || url.search || url.hash) throw new HtmlKitError("Static rendering requires an application pathname without a query or fragment.");
      const redirected = (location: string, status: RedirectStatus) => ({ status, pathname: url.pathname, location, ...redirectPage(location), css: "", components: [], layers: [] });
      // The redirects option precedes pages, with or without the trailing slash.
      const configured = redirects.get(url.pathname.endsWith("/") ? url.pathname : url.pathname + "/");
      if (configured !== undefined) return redirected(configured, 308);
      const matched = failure === undefined ? matchRoute(routes, url.pathname, config.base) : undefined;
      // Unmatched paths render app/pages/404.html and failures app/error.html, through their layouts, or a built-in page.
      const fallback = failure === undefined ? notFoundRoute : errorRoute;
      if (matched === undefined && fallback === undefined) return failure === undefined ? notFound() : errorPage(failure, url.pathname, scripts);
      const { route, params } = matched ?? { route: fallback!, params: {} };
      const status = failure?.status ?? (matched === undefined ? 404 as const : 200 as const);
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
        importMap: map,
        readComponent: async (url) => {
          let source = sources.get(fileURLToPath(url)) ?? await readFile(fileURLToPath(url), "utf8");
          for (const [tag, href] of builtins) if (new RegExp(`<${tag}[\\s/>]`).test(source)) source += `\n<link rel="component" href="${href}">`;
          const parsed = layerURLs.has(url) ? applicationResource(source, url) : parseComponentResource(source, url);
          if ("configuration" in parsed) resources.set(url, parsed);
          const imports = [...parsed.dependencies, ...parsed.definitions.flatMap(definition => definition.controller === undefined ? [] : [definition.controller])];
          for (const specifier of imports) {
            if (/^(?:[A-Za-z][A-Za-z\d+.-]*:|\/|\.\.?\/)/.test(specifier) || Object.keys(map.imports).some(key => specifier.startsWith(key))) continue;
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
      const attributes: Record<string, string>[] = [];
      let parent: Readonly<Record<string, unknown>> = Object.freeze({});
      let head: RenderedHead = {};
      // An alias marks its page's own URL current, with the alias's parameters.
      const current = route.canonical === undefined ? url.pathname : config.base + route.canonical.slice(1).split("/").filter(Boolean).map(segment => {
        const value = params[parameter(segment) ?? ""];
        return (value === undefined ? [segment] : [value].flat().map(encodeURIComponent)).map(part => part + "/").join("");
      }).join("");
      for (const layer of layers) {
        signal.throwIfAborted();
        const loaded = await module(layer);
        const context = { phase: "prerender" as const, url: new URL(url), base: config.base, params, parent,
          propNames: Object.freeze(Object.keys(layerDefinitions[results.length]!.contract.props)),
          fetch: globalThis.fetch, signal,
          navigation: (query?: NavigationQuery) => navigation({ current, ...query }),
          navigationTree: (query?: NavigationQuery) => navigationTree({ current, ...query }),
          breadcrumbs: (query?: NavigationQuery) => breadcrumbs({ current, ...query }),
          pager: (query?: NavigationQuery) => pager({ current, ...query }),
          redirect(location: string, status: RedirectStatus = 303): never {
            if (!redirectStatuses.includes(status)) throw new HtmlKitError(`Redirect status ${String(status)} must be 301, 302, 303, 307, or 308.`, origin(layer));
            throw new Redirect(redirectLocation(config.base, location, origin(layer)), status);
          },
          get request(): Request { throw new HtmlKitError("request is unavailable during static generation.", origin(layer)); } };
        let result: LoaderResult;
        // app/error.html takes the failure's status and message as the props it declares.
        const supplied = failure === undefined || layer !== route ? {} : { props: Object.fromEntries(Object.entries(failure)
          .filter(([name]) => Object.hasOwn(layerDefinitions[results.length]!.contract.props, name))) };
        try { result = loaded.load === undefined ? supplied : await loaded.load(context); }
        catch (error) { if (error instanceof Redirect) return redirected(error.location, error.status); throw error; }
        if (result === null || typeof result !== "object" || Array.isArray(result)) throw new HtmlKitError("load() must return a LoaderResult object.", origin(layer));
        results.push(result);
        parent = Object.freeze({ ...parent, ...result.data });
        const index = results.length - 1;
        // Checked against the layer's own component, which a prop's diagnostic names; its head reuses them.
        attributes.push(invocationAttributes(layerDefinitions[index]!, result));
        head = await renderHead(resources.get(pathToFileURL(layer.component).href)!, layerDefinitions[index]!, result, head, url.href,
          definition => invocation(definition.contract.tag, attributes[index]!, "hk-head", "", false));
      }
      if (scripts.length > 0) head = { ...head, scripts };
      // An alias names its page's own URL canonical, unless the page names one.
      const elements = head.elements ?? [];
      if (route.canonical !== undefined && !current.includes("[") && !elements.some(element => element.tag === "link" && element.attributes.rel?.toLowerCase().split(/\s+/).includes("canonical"))) {
        head = { ...head, elements: [...elements, { tag: "link", attributes: { rel: "canonical", href: (options.origin === undefined ? "" : config.origin) + current } }] };
      }
      const state: Record<string, Readonly<Record<string, unknown>>> = {};
      const rendered: RenderedLayer[] = layers.map((_layer, i) => ({ component: layerDefinitions[i]!.contract.tag,
        attributes: attributes[i]!, ...(results[i]!.state === undefined ? {} : { state: results[i]!.state }) }));
      let body = "";
      for (let i = layers.length - 1; i >= 0; i--) {
        const id = `hk-layer-${i}`;
        const layer = rendered[i]!;
        if (layer.state !== undefined) state[`#${id}`] = layer.state;
        body = invocation(layer.component, layer.attributes, id, body, i > 0);
      }
      const components: BrowserDefinition[] = [...graph.nodes.values()].map(node => ({ definition: node.definition,
        styles: compileComponentStylesForBuild(node.definition.css, node.definition),
        ...(node.controller === undefined ? {} : { controller: fileURLToPath(node.controller.url) }) }));
      const output = await renderComponents(body, { definitions: components.map(value => value.definition), url: url.href, state });
      signal.throwIfAborted();
      return { status, pathname: url.pathname, body: output.html, css: output.css, head,
        html: documentHTML(output.html, head), components, layers: rendered };
    },
    // Not a method of `this`: runtimes are handed the function itself, as in Deno.serve(application.fetch).
    async fetch(request) {
      if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405, headers: { allow: "GET, HEAD" } });
      const { pathname } = new URL(request.url);
      // A page's payload, through the same render as its document.
      const pages = config.base + "_htmlkit/pages/";
      const payload = pathname.startsWith(pages) ? /^(.*\/)?payload\.json$/.exec(pathname.slice(pages.length)) : null;
      if (payload !== null) {
        const page = await application.render(config.base + (payload[1] ?? ""), request.signal).catch((error: unknown) => { report(error, request.signal); });
        // A failed page has no payload, so the browser loads its document, the error page.
        if (page === undefined) return new Response(null, { status: 500 });
        const data = page.status === 200 && payloadPath(config.base, page.pathname) === pathname
          ? pagePayload(page, assets?.(page) ?? { styles: [], modules: [] }) : undefined;
        return new Response(data === undefined || request.method === "HEAD" ? null : JSON.stringify(data),
          { status: data === undefined ? 404 : 200, headers: { "content-type": "application/json" } });
      }
      const page = await application.render(pathname, request.signal).catch((error: unknown) => failed(error, pathname, request.signal));
      if (page.location !== undefined) {
        return new Response(request.method === "HEAD" ? null : page.html,
          { status: page.status, headers: { location: page.location, "content-type": "text/html; charset=utf-8" } });
      }
      if (page.status === 200 && !pathname.endsWith("/")) return new Response(null, { status: 308, headers: { location: pathname + "/" } });
      return new Response(request.method === "HEAD" ? null : documentHTML(page.body, page.head, assets?.(page)),
        { status: page.status, headers: { "content-type": "text/html; charset=utf-8" } });
    },
    async close() { if (ownsServer) await server.close(); },
  };
  /**
   * A loader or render failure answers with app/error.html and a safe message; the error itself goes
   * to the console. The development server, which supplies the module server, shows the error instead.
   */
  const report = (error: unknown, signal: AbortSignal): void => { if (!ownsServer || signal.aborted) throw error; console.error(error); };
  const failed = async (error: unknown, pathname: string, signal: AbortSignal): Promise<RenderedPage> => {
    report(error, signal);
    const failure: Failure = { status: 500, message: "Internal Server Error" };
    const render = application.render as (pathname: string, signal: AbortSignal, failure: Failure) => Promise<RenderedPage>;
    // The error page shares the site's layouts, so a failing layout fails it too; the built-in page answers then.
    return render(pathname, signal, failure).catch((again: unknown) => { report(again, signal); return errorPage(failure, pathname, scripts); });
  };
  return application;
}
