import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

import { compileComponentStylesForBuild, parseComponentResource, type ComponentDefinition } from "@nextwebwg/html-next";
import { loadNodeComponents } from "@nextwebwg/html-next/node-loader";
import { createRenderer } from "@nextwebwg/html-next/server";
import { createServer, isRunnableDevEnvironment, type ViteDevServer } from "vite";

import { configure, HtmlKitError, rootAlias, withPlugins } from "./config.js";
import { sitePolicy } from "./csp.js";
import { authoredHead, documentHTML, redirectPage, type PageAssets } from "./document.js";
import { breadth, discover, discoverServerFiles, matchRoute, parameter, redirectTable, validSegment } from "./routes.js";
import { applicationResource, pageDefinition, withoutSettings } from "./resource.js";
import { createProviderModules } from "./providers.js";
import { serverReaders } from "./private-readers.js";
import { privateReadResponse, type PrivateReadRegistration } from "./private-api.js";
import { createNavigation, failurePage, pageAction, pageResponse, prerenderedActions, renderRoute, requestReadContext, respond, serverFailure, type Failure, type Pipeline, type RenderLayer } from "./server.js";
import type { Application, ApplicationOptions, ContentSecurityPolicyOptions, RenderedPolicy, ApplicationRoute, BrowserDefinition, EndpointModule, Middleware, PageAction, RedirectStatus, RenderedHead, RenderedPage, RouteLayer,
  RouteParam, ServerModule } from "./types.js";

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
export function notFoundPage(scripts: readonly string[], policy?: RenderedPolicy) {
  const head: RenderedHead = { html: authoredHead + "<title>Page not found</title>", scripts, ...(policy === undefined ? {} : { csp: policy }) };
  const body = "<main><h1>Page not found</h1></main>";
  return { head, body, html: documentHTML(body, head) };
}

/** A route's components, ready to render: its layers, every component they use, and their browser delivery. */
export interface RouteGraph {
  readonly layers: readonly RenderLayer[];
  readonly definitions: readonly ComponentDefinition[];
  readonly components: readonly BrowserDefinition[];
}

/** The application, plus what a build reads from it: each route's component graph and the concrete page URLs. */
export async function createApplicationInternals(input: ApplicationOptions = {}, moduleServer?: ViteDevServer,
  assets?: (page: RenderedPage) => PageAssets, policy?: ContentSecurityPolicyOptions | false) {
  const options = await withPlugins(input);
  const config = configure(options);
  const redirects = redirectTable(config.base, options.redirects);
  const { routes, notFound: notFoundRoute, error: errorRoute, sources, files, watched } = await discover(config.root, { ...options, base: config.base });
  // Alias pages name their own URL canonical, absolute when the site sets its origin.
  const canonicalOrigin = options.origin === undefined ? "" : config.origin;
  const { endpoints, middleware } = await discoverServerFiles(config.root);
  // A dynamic page's entries are checked the same way when they are listed.
  const shadowed = routes.find(route => route.params.length === 0 && redirects.has(config.base + route.pattern.slice(1)));
  if (shadowed !== undefined) throw new HtmlKitError(`The redirects option also redirects ${shadowed.pattern}, which is this page's URL.`, shadowed.component);
  const scripts = await headScripts(options, config.root);
  const csp = policy ?? config.csp;
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
  const renderer = createRenderer();
  const privateLifetime = new AbortController();
  const privateSources = new Map<string, PrivateReadRegistration>();
  const providers = createProviderModules(config.root, {
    cacheDir: server.config.cacheDir,
    async resolve(specifier, importer) {
      const resolved = await server.environments.client!.pluginContainer.resolveId(specifier, importer);
      return resolved === null || resolved.external ? undefined : resolved.id.split("?")[0];
    },
    watch: file => { server.watcher.add(file); },
  });
  // Diagnostics name a loader's file, or its component when a plugin supplies the loader module.
  const origin = (layer: RouteLayer): string => typeof layer.server === "string" ? layer.server : layer.component;

  // Materialize entries once per application so loaders and navigation see the same catalog.
  const unenumerated: ApplicationRoute[] = [];
  let catalog: Promise<ReadonlyMap<string, ApplicationRoute>> | undefined;
  const concreteRoutes = () => catalog ??= (async () => {
    const paths = new Map<string, ApplicationRoute>();
    for (const route of routes) {
      const loaded = await module(route);
      if (loaded.actions !== undefined && route.render !== "server") throw prerenderedActions(route.pattern, origin(route));
      // A server-rendered dynamic page renders whatever its URL names, so it needs no entries().
      if (route.params.length > 0 && typeof loaded.entries !== "function") {
        if (route.render !== "server") unenumerated.push(route);
        continue;
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
  const navigation = createNavigation(config.base, routes, concreteRoutes);

  // Vite owns module caching and dependency invalidation. Per-render results never enter
  // a shared cache; HTML Next owns the DOM worker and declarative component semantics.
  const graph = async (route: ApplicationRoute): Promise<RouteGraph> => {
    const layers = [...route.layouts, route];
    const packages = new Map<string, ReturnType<typeof packageResource>>();
    const resources = new Map<string, ReturnType<typeof applicationResource>>();
    const layerURLs = new Set(layers.map(layer => pathToFileURL(layer.component).href));
    const resolveCSS = server.config.createResolver({ extensions: [".css"], mainFields: ["style"], conditions: ["style", "development|production"], preferRelative: true, tryIndex: false });
    const loaded = await loadNodeComponents(layers.map(layer => pathToFileURL(layer.component).href), {
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
        const imports = [...parsed.dependencies, ...parsed.definitions.flatMap(definition => (definition.module ?? definition.controller) === undefined ? [] : [(definition.module ?? definition.controller)!])];
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
    const definitions = layers.map(layer => {
      if (layer === route) return pageDefinition(resources.get(pathToFileURL(layer.component).href)!, layer.component);
      const roots = loaded.roots.filter(id => loaded.nodes.get(id)!.url === pathToFileURL(layer.component).href);
      if (roots.length !== 1) throw new HtmlKitError("A page or layout must declare exactly one root component.", layer.component);
      return withoutSettings(loaded.nodes.get(roots[0]!)!.definition);
    });
    if (definitions.at(-1)!.contract.tag !== route.pageName) {
      throw new HtmlKitError("Page component name changed; rediscover routes before rendering.", route.component);
    }
    for (const definition of definitions.slice(0, -1)) {
      if (!definition.slots?.some(slot => slot.name === "page")) throw new HtmlKitError('Layout requires a slot named "page".', definition.source.file);
    }
    const carriers = new Map<string, { count: number; explicit: boolean }>();
    for (const node of loaded.nodes.values()) {
      const carrier = carriers.get(node.url) ?? { count: 0, explicit: false };
      carrier.count += 1;
      carrier.explicit ||= node.module !== undefined || node.controller !== undefined;
      carriers.set(node.url, carrier);
    }
    const siblings = new Map<string, Promise<string | undefined>>();
    const sibling = (file: string, suffix = ""): string | undefined => {
      const stem = file.slice(0, -extname(file).length) + suffix;
      const candidates = [stem + ".js", stem + ".ts"].filter(path => existsSync(path));
      if (candidates.length > 1) throw new HtmlKitError(`${suffix === "" ? "Component" : suffix === ".client" ? "Client" : "Server"} sibling module is ambiguous: ${candidates.map(path => basename(path)).join(", ")}; ${suffix === "" ? "select one with an explicit module attribute" : `keep one ${suffix.slice(1)} companion`}.`, file);
      return candidates[0];
    };
    const companion = (url: string): Promise<string | undefined> => {
      let found = siblings.get(url);
      if (found !== undefined) return found;
      found = (async () => {
        const carrier = carriers.get(url)!;
        if (carrier.count > 1 && carrier.explicit) return undefined;
        const file = fileURLToPath(url);
        const found = sibling(file);
        if (found === undefined) return undefined;
        if (carrier.count > 1) {
          throw new HtmlKitError("A sibling module is ambiguous for a file declaring several components; set module on the template it belongs to.", file);
        }
        return found;
      })();
      siblings.set(url, found);
      return found;
    };
    const components = await providers.resolve(await Promise.all([...loaded.nodes.values()].map(async node => {
      let module = node.module === undefined
        ? node.controller !== undefined || node.imported || !node.url.startsWith("file:") ? undefined : await companion(node.url)
        : fileURLToPath(node.module.url);
      let client: string | undefined;
      let privateModule: string | undefined;
      let readers: readonly string[] | undefined;
      if (node.controller === undefined && !node.imported && node.url.startsWith("file:")) {
        const carrier = carriers.get(node.url)!;
        if (module !== undefined && /\.client\.[jt]s$/.test(module)) { client = module; module = undefined; }
        else if (module !== undefined || !carrier.explicit) {
          client = sibling(module ?? fileURLToPath(node.url), ".client");
          if (client !== undefined && module === undefined && carrier.count > 1) throw new HtmlKitError("A client sibling is ambiguous for a file declaring several components; set module on the template it belongs to.", fileURLToPath(node.url));
        }
        const candidate = sibling(module ?? fileURLToPath(node.url), ".server");
        if (candidate !== undefined && (module !== undefined || carrier.count === 1)) {
          const found = serverReaders(await environment.runner.import(candidate), candidate);
          if (found !== undefined && Object.keys(found).length > 0) {
            if (module === undefined) throw new HtmlKitError("Private readers require a common module containing their input selectors.", candidate);
            privateModule = candidate; readers = Object.keys(found);
          }
        }
      }
      return { definition: withoutSettings(node.definition), styles: compileComponentStylesForBuild(node.definition.css, node.definition),
        ...(node.controller === undefined ? {} : { controller: fileURLToPath(node.controller.url) }),
        ...(client === undefined ? {} : { client }),
        ...(privateModule === undefined ? {} : { server: privateModule }), ...(readers === undefined ? {} : { privateReaderNames: readers }),
        ...(module === undefined ? {} : { module }) };
    })));
    for (const component of components) if (component.server !== undefined && component.binding !== undefined) privateSources.set(component.binding.source, {
      definition: component.definition, common: () => environment.runner.import(component.module!),
      readers: async () => serverReaders(await environment.runner.import(component.server!), component.server!)!,
    });
    return { components, definitions: components.map(component => component.definition), layers: layers.map((layer, i) => ({ definition: definitions[i]!,
      module: () => module(layer), origin: origin(layer) })) };
  };

  // One policy for the whole site, from every component a page, layout, the not-found page, or the error page uses.
  // ponytail: built from every route's graph once per application; the development server rebuilds the application on a change.
  let computed: Promise<RenderedPolicy | undefined> | undefined;
  const site = () => computed ??= (async () => {
    if (csp === false) return undefined;
    const seen = new Set<string>();
    const definitions: ComponentDefinition[] = [];
    for (const route of [...routes, ...notFoundRoute === undefined ? [] : [notFoundRoute], ...errorRoute === undefined ? [] : [errorRoute]]) {
      const key = [...route.layouts, route].map(layer => layer.component).join("\0");
      if (seen.has(key)) continue;
      seen.add(key);
      definitions.push(...(await graph(route)).definitions);
    }
    return sitePolicy(csp, definitions, scripts);
  })();

  type Page = RenderedPage & { readonly headers?: Headers };
  const builtinNotFound = async (pathname: string): Promise<Page> => ({ status: 404, pathname, ...notFoundPage(scripts, await site()), css: "", components: [], layers: [] });
  const redirected = async (pathname: string, location: string, status: RedirectStatus, headers?: Headers): Promise<Page> =>
    ({ status, pathname, location, ...redirectPage(location, await site()), css: "", components: [], layers: [], ...(headers === undefined ? {} : { headers }) });
  const builtinFailure = async (pathname: string): Promise<Page> => ({ pathname, ...failurePage(serverFailure, scripts, await site()), css: "", components: [], layers: [] });
  // A matched route; without one, the not-found page, or for a failure the error page, through its layouts.
  // request makes it a request-time render.
  const renderPage = async (matched: { route: ApplicationRoute; params: Readonly<Record<string, RouteParam>> } | undefined, url: URL,
    request: Request | undefined, signal: AbortSignal, failure?: Failure, action?: PageAction): Promise<Page> => {
    const fallback = failure === undefined ? notFoundRoute : errorRoute;
    if (matched === undefined && fallback === undefined) return failure === undefined ? builtinNotFound(url.pathname) : builtinFailure(url.pathname);
    const { route, params } = matched ?? { route: fallback!, params: {} };
    const { layers, definitions, components } = await graph(route);
    const rendered = await renderRoute({ base: config.base, canonicalOrigin, route, params, url, ...(request === undefined ? {} : { request }), signal, layers,
      definitions, providers: Object.fromEntries(components.flatMap(component => component.binding === undefined ? [] : [[component.definition.contract.tag, component.binding]])),
      clientModules: components.filter(component => component.client !== undefined).map(component => component.definition.contract.tag),
      services: options.services,
      privateReaders: Object.fromEntries(components.flatMap(component => component.server === undefined ? [] : [[component.definition.contract.tag,
        async () => serverReaders(await environment.runner.import(component.server!), component.server!)!]])),
      render: renderer.render, scripts, ...(await site().then(site => site === undefined ? {} : { policy: site })), navigation, ...(failure === undefined ? {} : { failure }),
      ...(action === undefined ? {} : { action }) });
    if (rendered.kind === "redirect") return redirected(url.pathname, rendered.location, rendered.status, rendered.headers);
    if (rendered.kind === "notFound") {
      // The not-found and error pages' own notFound() falls back to the built-in page.
      const page = matched === undefined ? builtinNotFound(url.pathname) : await renderPage(undefined, url, undefined, signal);
      return { ...page, headers: rendered.headers };
    }
    return { status: failure?.status ?? (matched === undefined ? 404 : rendered.status), pathname: url.pathname, body: rendered.body, css: rendered.css, head: rendered.head,
      html: documentHTML(rendered.body, rendered.head), components, layers: rendered.layers, headers: rendered.headers,
      ...(rendered.prepared === undefined ? {} : { prepared: rendered.prepared }) };
  };
  /**
   * A failure answers with app/error.html and a safe message; the error itself goes to the console. The
   * development server, which supplies the module server, shows the error instead.
   */
  const failed = async (error: unknown, request: Request): Promise<Response> => {
    const report = (error: unknown) => { if (!ownsServer || request.signal.aborted || privateLifetime.signal.aborted) throw error; console.error(error); };
    report(error);
    const { pathname } = new URL(request.url);
    // A failed page has no payload, so the browser loads its document, the error page.
    if (pathname.startsWith(config.base + "_htmlkit/pages/")) return new Response(null, { status: 500 });
    // The error page shares the site's layouts, so a failing layout fails it too; the built-in page answers then.
    const page = await (pathname.startsWith("//") ? builtinFailure(pathname) : renderPage(undefined, new URL(pathname, config.origin), undefined, request.signal, serverFailure)
      .catch((again: unknown) => { report(again); return builtinFailure(pathname); }));
    return pageResponse(page, request, false, assets?.(page));
  };
  const pipeline: Pipeline<ApplicationRoute> = {
    base: config.base, routes, endpoints,
    read(request) {
      request = new Request(request, { signal: AbortSignal.any([request.signal, privateLifetime.signal]) });
      return privateReadResponse(request, config.base, privateSources, url => requestReadContext(request, url, config.base,
        matchRoute(routes, url.pathname, config.base)?.params ?? {}, options.services));
    },
    redirects: new Map([...redirects].map(([from, location]) => [from, { location, status: 308 as const }])),
    endpoint: async route => await environment.runner.import(route.file) as EndpointModule,
    ...(middleware === undefined ? {} : { middleware: async () => {
      const handler = (await environment.runner.import(middleware) as { default?: unknown }).default;
      if (typeof handler !== "function") throw new HtmlKitError("Middleware must export a default function.", middleware);
      return handler as Middleware;
    } }),
    async page(route, params, request, payload) {
      const url = new URL(request.url);
      // A prerendered page renders as the build renders it: at its canonical URL, without the request.
      const server = route.render === "server";
      let action: PageAction | undefined;
      if (request.method === "POST") {
        const loaded = await module(route);
        // As the build does, so development names the page too.
        if (loaded.actions !== undefined && !server) throw prerenderedActions(route.pattern, origin(route));
        const found = pageAction(loaded, url);
        if (found instanceof Response) return found;
        action = found;
      }
      const page = await renderPage({ route, params }, server ? url : new URL(url.pathname, config.origin), server ? request : undefined, request.signal, undefined, action);
      return pageResponse(page, request, payload, assets?.(page));
    },
    async notFound(request, payload) {
      const { pathname } = new URL(request.url);
      if (payload) return new Response(null, { status: 404 });
      const page = await (pathname.startsWith("//") ? builtinNotFound(pathname) : renderPage(undefined, new URL(pathname, config.origin), undefined, request.signal));
      return pageResponse(page, request, false, assets?.(page));
    },
  };
  const application: Application = {
    ...config, routes, ...(notFoundRoute === undefined ? {} : { notFound: notFoundRoute }), ...(errorRoute === undefined ? {} : { error: errorRoute }),
    navigation: navigation.navigation, navigationTree: navigation.navigationTree,
    files, watchFiles: watched, endpoints, ...(middleware === undefined ? {} : { middleware }),
    async entries() {
      const paths = await concreteRoutes();
      const missing = unenumerated[0];
      if (missing !== undefined) throw new HtmlKitError(`Static entries() must enumerate parameters: ${missing.params.join(", ")}.`, origin(missing));
      // Server-rendered pages render on request, so a build lists only prerendered ones.
      return [...paths].filter(([, route]) => route.render !== "server").map(([path]) => path).sort();
    },
    async render(pathname, signal = new AbortController().signal) {
      signal.throwIfAborted();
      // A path starting with // would name another origin; no page lives there, for documents or payloads.
      if (pathname.startsWith("//")) return builtinNotFound(pathname);
      const url = new URL(pathname, config.origin);
      if (url.origin !== config.origin || url.search || url.hash) throw new HtmlKitError("Static rendering requires an application pathname without a query or fragment.");
      // The redirects option precedes pages, with or without the trailing slash.
      const configured = redirects.get(url.pathname.endsWith("/") ? url.pathname : url.pathname + "/");
      if (configured !== undefined) return redirected(url.pathname, configured, 308);
      return renderPage(matchRoute(routes, url.pathname, config.base), url, undefined, signal);
    },
    // Not a method of `this`: runtimes are handed the function itself, as in Deno.serve(application.fetch).
    fetch: request => respond(pipeline, request).catch((error: unknown) => failed(error, request)),
    async close() {
      privateLifetime.abort();
      try { await Promise.all([renderer.close(), ...ownsServer ? [server.close()] : []]); }
      finally { await providers.close(); }
    },
  };
  return { application, graph, catalog: concreteRoutes, policy: site };
}

/**
 * assets supplies a serving adapter's browser modules and stylesheets for fetch(), and policy the csp
 * option it applies in place of the configured one, as the development server adds what Vite needs.
 */
export async function createApplication(input: ApplicationOptions = {}, moduleServer?: ViteDevServer,
  assets?: (page: RenderedPage) => PageAssets, policy?: ContentSecurityPolicyOptions | false): Promise<Application> {
  return (await createApplicationInternals(input, moduleServer, assets, policy)).application;
}
