// The request-time core, shared by Application.fetch and the built server. Nothing here imports Vite,
// so a build's server entry runs on Node, Deno, or Bun with only the installed packages.
import { createServer as createHTTPServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile, realpath, stat } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

import { serializePropTarget, serializeTypedValue, type ComponentDefinition } from "@nextwebwg/html-next";
import { renderComponents, setRenderWorkers } from "@nextwebwg/html-next/server";

import { HtmlKitError, within } from "./config.js";
import { policyHeader } from "./csp.js";
import { authoredHead, documentHTML, escapeHTML, pagePayload, redirectPage, type PageAssets } from "./document.js";
import { matchRoute, parameter, redirectLocation, redirectStatuses } from "./routes.js";
import type { ApplicationRoute, ApplicationServer, EndpointModule, EndpointRoute, LoadContext, LoaderResult, ManifestRedirect, Middleware, NavigationItem,
  NavigationNode, NavigationQuery, PageAction, PagerLinks, RedirectStatus, RenderedHead, RenderedLayer, RouteParam, ServerApplication, ServerModule, StartOptions, RenderedPolicy } from "./types.js";

export { setRenderWorkers } from "@nextwebwg/html-next/server";
export type { ApplicationServer, EndpointContext, EndpointHandler, EndpointModule, Middleware, ServerApplication, StartOptions } from "./types.js";

/** A route as navigation and matching read it, without its source files. */
export type NavigationRoute = Omit<ApplicationRoute, "component" | "server" | "layouts">;
type Params = Readonly<Record<string, RouteParam>>;

/** navigation(), navigationTree(), breadcrumbs(), and pager() over routes and each concrete page URL's route. */
export function createNavigation(base: string, routes: readonly NavigationRoute[], concrete: () => Promise<ReadonlyMap<string, NavigationRoute>>) {
  const checkedFrom = (from = "/"): string => {
    if (!/^\/(?:[^/]+\/)*$/.test(from) || from.includes("[") || from.includes("?") || from.includes("#")) {
      throw new HtmlKitError("Navigation from requires a concrete application-relative directory prefix.", from);
    }
    return from;
  };
  const item = (href: string, route: NavigationRoute, depth: number, current: string | undefined): NavigationItem => Object.freeze({
    href, label: route.label ?? decodeURIComponent(href.slice(base.length).split("/").filter(Boolean).at(-1) ?? "Home"),
    current: href === current ? "page" as const : "false" as const, depth, pageName: route.pageName,
    ...(route.groups === undefined ? {} : { group: route.groups.at(-1)!.label }) });
  // A page's place in the file tree: each URL segment, with its (group) folders where they sit.
  // depth is the URL segments above the element: a segment's index, or a group's depth.
  const treePath = (href: string, route: NavigationRoute) => {
    const path: { name: string; rank: string | null; depth: number; group?: true }[] = href.slice(base.length).split("/").filter(Boolean)
      .map((name, i) => ({ name, rank: route.order?.[i] ?? null, depth: i }));
    // Deepest first, so each insertion index is still a count of URL segments.
    for (const group of (route.groups ?? []).toReversed()) path.splice(group.depth, 0, { name: group.label, rank: group.order, depth: group.depth, group: true });
    return path;
  };
  const navigation = async (query: NavigationQuery = {}): Promise<readonly NavigationItem[]> => {
    const from = checkedFrom(query.from);
    const prefix = base + from.slice(1);
    const depth = from.split("/").filter(Boolean).length;
    // Hidden pages and alias routes stay routable but out of navigation.
    const items = [...await concrete()].filter(([path, route]) => path.startsWith(prefix) && !route.hidden && route.canonical === undefined);
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
    return Object.freeze(items.map(([href, route]) => item(href, route, href.slice(base.length).split("/").filter(Boolean).length - depth, query.current)));
  };
  // Each existing page from `from` down to the current one, by URL; the current page is included even when hidden.
  const breadcrumbs = async (query: NavigationQuery = {}): Promise<readonly NavigationItem[]> => {
    const from = checkedFrom(query.from);
    const current = query.current;
    if (current === undefined || !current.startsWith(base + from.slice(1))) return Object.freeze([]);
    const paths = await concrete();
    const parts = current.slice(base.length).split("/").filter(Boolean);
    const start = from.split("/").filter(Boolean).length;
    const trail: NavigationItem[] = [];
    for (let i = start; i <= parts.length; i++) {
      const href = base + parts.slice(0, i).map(part => part + "/").join("");
      // The page being rendered exists even when no entries() lists it, as for a dynamic page at request time.
      const route = paths.get(href) ?? (i === parts.length ? matchRoute(routes, href, base)?.route : undefined);
      if (route !== undefined && route.canonical === undefined) trail.push(item(href, route, i - start, current));
    }
    return Object.freeze(trail);
  };
  // navigation()'s pages, which come in tree order, nested under the folders and groups below `from`.
  const navigationTree = async (query: NavigationQuery = {}): Promise<readonly NavigationNode[]> => {
    const items = await navigation(query);
    const paths = await concrete();
    const fromDepth = checkedFrom(query.from).split("/").filter(Boolean).length;
    type Draft = { label: string; order: string | null; children: Draft[]; item?: NavigationItem; route?: NavigationRoute };
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
  return { navigation, navigationTree, breadcrumbs, pager };
}
export type Navigation = ReturnType<typeof createNavigation>;

/** What a loader's redirect() throws, so render answers with the redirect instead of the page. */
class Redirect {
  constructor(readonly location: string, readonly status: RedirectStatus) {}
}
/** What a loader's notFound() throws. */
class NotFound { readonly status = 404; }

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

/** The request's cookies by name; the first of a repeated name wins, as the most specific path comes first. */
function parseCookies(header: string | null): ReadonlyMap<string, string> {
  const cookies = new Map<string, string>();
  for (const pair of (header ?? "").split(";")) {
    const separator = pair.indexOf("=");
    const name = pair.slice(0, separator).trim();
    if (separator < 0 || name === "" || cookies.has(name)) continue;
    let value = pair.slice(separator + 1).trim();
    if (value.length > 1 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    try { value = decodeURIComponent(value); } catch { /* Kept as sent. */ }
    cookies.set(name, value);
  }
  return cookies;
}

/** A page or layout, ready to render: its component and loader. */
export interface RenderLayer {
  readonly definition: ComponentDefinition;
  readonly module: () => Promise<ServerModule>;
  /** What diagnostics name: the loader file, or the component when a plugin supplies the loader module. */
  readonly origin: string;
}
export interface RenderInput {
  readonly base: string;
  readonly route: NavigationRoute;
  readonly params: Params;
  readonly url: URL;
  /** The request a server-rendered page answers; prerendering has none. */
  readonly request?: Request;
  readonly signal: AbortSignal;
  readonly layers: readonly RenderLayer[];
  /** Every component the layers use, for HTML Next's renderer. */
  readonly definitions: readonly ComponentDefinition[];
  readonly scripts: readonly string[];
  /** The site's Content Security Policy, unless csp is false. */
  readonly policy?: RenderedPolicy;
  readonly navigation: Navigation;
  /** What starts an alias page's canonical link: the configured origin, or "" without one. */
  readonly canonicalOrigin: string;
  /** For the error page: the failure, whose fields it takes as the props it declares. */
  readonly failure?: Failure;
  /** For a POST, the page's action that pageAction() found, which runs before the loaders. */
  readonly action?: PageAction;
}
/** What app/error.html receives: the status and its standard reason phrase, never the error itself. */
export interface Failure { readonly status: 500; readonly message: string }
export const serverFailure: Failure = Object.freeze({ status: 500, message: "Internal Server Error" });
/** The page for a failure without app/error.html, or when it fails too. */
export function failurePage({ status, message }: Failure, scripts: readonly string[], policy?: RenderedPolicy) {
  const head: RenderedHead = { html: authoredHead + `<title>${escapeHTML(message)}</title>`, scripts, ...(policy === undefined ? {} : { csp: policy }) };
  const body = `<main><h1>${escapeHTML(message)}</h1></main>`;
  return { status, head, body, html: documentHTML(body, head) };
}
export type Rendered =
  | { readonly kind: "page"; readonly status: number; readonly headers: Headers; readonly body: string; readonly css: string; readonly head: RenderedHead; readonly layers: readonly RenderedLayer[] }
  | { readonly kind: "redirect"; readonly status: RedirectStatus; readonly location: string; readonly headers: Headers }
  | { readonly kind: "notFound"; readonly headers: Headers };

/** Run the layers' loaders, outermost first, and render their invocations through HTML Next. */
export async function renderRoute(input: RenderInput): Promise<Rendered> {
  const { base, route, params, url, request, signal, layers, navigation } = input;
  const response = { status: 200, headers: new Headers() };
  let cookies: ReadonlyMap<string, string> | undefined;
  const results: LoaderResult[] = [];
  const attributes: Record<string, string>[] = [];
  let parent: Readonly<Record<string, unknown>> = Object.freeze({});
  let lang: string | undefined;
  // A pattern's URL with this request's parameters.
  const at = (pattern: string) => base + pattern.slice(1).split("/").filter(Boolean).map(segment => {
    const value = params[parameter(segment) ?? ""];
    return (value === undefined ? [segment] : [value].flat().map(encodeURIComponent)).map(part => part + "/").join("");
  }).join("");
  // An alias marks its page's own URL current, with the alias's parameters.
  const current = route.canonical === undefined ? url.pathname : at(route.canonical);
  const contextOf = (layer: RenderLayer): LoadContext => {
    const prerendering = (name: string): never => {
      throw new HtmlKitError(`${name} is unavailable while prerendering; <meta name="hk:render" content="server"> renders the page on each request.`, layer.origin);
    };
    return { phase: request === undefined ? "prerender" : "request", url: new URL(url), base, params, parent,
      propNames: Object.freeze(Object.keys(layer.definition.contract.props)),
      fetch: globalThis.fetch, signal,
      navigation: query => navigation.navigation({ current, ...query }),
      navigationTree: query => navigation.navigationTree({ current, ...query }),
      breadcrumbs: query => navigation.breadcrumbs({ current, ...query }),
      pager: query => navigation.pager({ current, ...query }),
      redirect(location: string, status: RedirectStatus = 303): never {
        if (!redirectStatuses.includes(status)) throw new HtmlKitError(`Redirect status ${String(status)} must be 301, 302, 303, 307, or 308.`, layer.origin);
        throw new Redirect(redirectLocation(base, location, layer.origin), status);
      },
      notFound(): never { throw new NotFound(); },
      get request() { return request ?? prerendering("request"); },
      get cookies() { return request === undefined ? prerendering("cookies") : cookies ??= parseCookies(request.headers.get("cookie")); },
      get response() { return request === undefined ? prerendering("response") : response; } };
  };
  // What a loader's or action's redirect() and notFound() answer with.
  const stopped = (error: unknown): Rendered => {
    if (error instanceof Redirect) return { kind: "redirect", location: error.location, status: error.status, headers: response.headers };
    if (error instanceof NotFound) return { kind: "notFound", headers: response.headers };
    throw error;
  };
  // The action runs first, so every loader sees what it changed.
  let submitted: Readonly<Record<string, unknown>> | undefined;
  if (input.action !== undefined) {
    const page = layers.at(-1)!;
    let result: unknown;
    try { result = await input.action(contextOf(page)); }
    catch (error) { return stopped(error); }
    if (result === undefined) {
      // POST/redirect/GET: the page's own URL, without the action's name.
      const location = new URL(url);
      location.search = new URLSearchParams([...location.searchParams].filter(([key]) => !key.startsWith("/"))).toString();
      return { kind: "redirect", location: location.pathname + location.search, status: 303, headers: response.headers };
    }
    if (result === null || typeof result !== "object" || Array.isArray(result)) {
      throw new HtmlKitError("An action returns nothing, which redirects to its page, or an object of the page's props.", page.origin);
    }
    submitted = result as Readonly<Record<string, unknown>>;
  }
  for (const layer of layers) {
    signal.throwIfAborted();
    const loaded = await layer.module();
    const context = contextOf(layer);
    let result: LoaderResult;
    // app/error.html takes the failure's status and message as the props it declares.
    const supplied = input.failure === undefined || layer !== layers.at(-1) ? {} : { props: Object.fromEntries(Object.entries(input.failure)
      .filter(([name]) => Object.hasOwn(layer.definition.contract.props, name))) };
    try { result = loaded.load === undefined ? supplied : await loaded.load(context); }
    catch (error) { return stopped(error); }
    if (result === null || typeof result !== "object" || Array.isArray(result)) throw new HtmlKitError("load() must return a LoaderResult object.", layer.origin);
    if (result.head !== undefined) {
      if (Object.keys(result.head).some(name => name !== "lang")) {
        throw new HtmlKitError("A loader's head sets only lang; a page or layout declares its <title> and <meta> in <defs>, bound to props its loader returns.", layer.origin);
      }
      lang = result.head.lang ?? lang;
    }
    // An action's props are the page's, over its loader's.
    if (submitted !== undefined && layer === layers.at(-1)) result = { ...result, props: { ...result.props, ...submitted } };
    results.push(result);
    parent = Object.freeze({ ...parent, ...result.data });
    // Checked against the layer's own component, which a prop's diagnostic names.
    attributes.push(invocationAttributes(layer.definition, result));
  }
  const state: Record<string, Readonly<Record<string, unknown>>> = {};
  const rendered: RenderedLayer[] = layers.map((layer, i) => ({ component: layer.definition.contract.tag,
    attributes: attributes[i]!, ...(results[i]!.state === undefined ? {} : { state: results[i]!.state }) }));
  let body = "";
  for (let i = layers.length - 1; i >= 0; i--) {
    const id = `hk-layer-${i}`;
    const layer = rendered[i]!;
    if (layer.state !== undefined) state[`#${id}`] = layer.state;
    body = invocation(layer.component, layer.attributes, id, body, i > 0);
  }
  // An alias names its page's own URL canonical, and a page in an alias page directory the same page
  // under its directory's own prefix, unless a component on the page declares one.
  const own = route.aliasOf === undefined ? route.canonical === undefined ? undefined : current : at(route.aliasOf);
  const canonical = own !== undefined && !own.includes("[") && !input.definitions.some(definition => definition.head?.some(declaration =>
    declaration.kind === "link" && declaration.attributes.some(attribute => attribute.kind === "literal" && attribute.name === "rel" && attribute.value.trim().toLowerCase() === "canonical")))
    ? input.canonicalOrigin + own : undefined;
  const output = await renderComponents(body, { definitions: input.definitions, url: url.href, state,
    head: authoredHead + (canonical === undefined ? "" : `<link rel="canonical" href="${escapeHTML(canonical)}">`) });
  signal.throwIfAborted();
  const { policy } = input;
  const head: RenderedHead = { html: output.head, ...(lang === undefined ? {} : { lang }), ...(canonical === undefined ? {} : { canonical }),
    ...(input.scripts.length === 0 ? {} : { scripts: input.scripts }), ...(policy === undefined ? {} : { csp: policy }) };
  return { kind: "page", status: response.status, headers: response.headers, body: output.html, css: output.css, head, layers: rendered };
}

/** A page's answer: a redirect with its redirect page, its document, or for a payload request its payload (404 when it has none). */
export function pageResponse(page: { readonly status: number; readonly location?: string; readonly body: string; readonly head: RenderedHead;
  readonly layers: readonly RenderedLayer[]; readonly headers?: Headers }, request: Request, payload: boolean, assets: PageAssets = { styles: [], modules: [] }): Response {
  const headers = new Headers(page.headers);
  const bodyless = request.method === "HEAD";
  if (payload) {
    // Client navigation finds no payload for a redirect or an error, and loads the URL itself.
    const data = page.location === undefined ? pagePayload(page, assets) : undefined;
    headers.set("content-type", "application/json");
    return new Response(data === undefined || bodyless ? null : JSON.stringify(data), { status: data === undefined ? 404 : 200, headers });
  }
  headers.set("content-type", "text/html; charset=utf-8");
  if (page.head.csp !== undefined) headers.set(policyHeader(page.head.csp), page.head.csp.header);
  if (page.location !== undefined) {
    headers.set("location", page.location);
    return new Response(bodyless ? null : redirectPage(page.location).html, { status: page.status, headers });
  }
  return new Response(bodyless ? null : documentHTML(page.body, page.head, assets), { status: page.status, headers });
}

/** How an application answers requests: its routes and endpoints, and how it answers a page. */
export interface Pipeline<Route extends NavigationRoute> {
  readonly base: string;
  /** Redirects by deployment pathname with a trailing slash. */
  readonly redirects: ReadonlyMap<string, { readonly location: string; readonly status: RedirectStatus }>;
  readonly routes: readonly Route[];
  readonly endpoints: readonly EndpointRoute[];
  endpoint(route: EndpointRoute): Promise<EndpointModule>;
  readonly middleware?: () => Promise<Middleware>;
  /** A matched page's document or payload. */
  page(route: Route, params: Params, request: Request, payload: boolean): Promise<Response>;
  /** A path no page or endpoint answers. */
  notFound(request: Request, payload: boolean): Promise<Response>;
}

const methods = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"] as const;

/** Answer a request: its payload URL becomes the page's, then middleware, then redirects, endpoints, and pages. */
export async function respond<Route extends NavigationRoute>(app: Pipeline<Route>, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const pages = app.base + "_htmlkit/pages/";
  let payload = false;
  const page = url.pathname.startsWith(pages) ? /^(.*\/)?payload\.json$/.exec(url.pathname.slice(pages.length)) : null;
  if (page !== null) {
    if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405, headers: { allow: "GET, HEAD" } });
    payload = true;
    // Concatenated, so a payload path starting with // stays on this origin and names no page.
    request = new Request(url.origin + app.base + (page[1] ?? "") + url.search, { method: request.method, headers: request.headers, signal: request.signal });
  }
  const answer = (request: Request) => route(app, request, payload);
  if (app.middleware === undefined) return answer(request);
  const middleware = await app.middleware();
  const next = async (rewrite?: string | URL | Request) => {
    const answered = await answer(rewrite === undefined ? request : rewrite instanceof Request ? rewrite : new Request(new URL(rewrite, request.url), request));
    // A new Response around the answer, so middleware can set headers even on Response.redirect()'s.
    return new Response(answered.body, answered);
  };
  const response: unknown = await middleware(request, next);
  if (!(response instanceof Response)) throw new HtmlKitError("Middleware must return a Response, such as next()'s.");
  return response;
}

async function route<Route extends NavigationRoute>(app: Pipeline<Route>, request: Request, payload: boolean): Promise<Response> {
  const url = new URL(request.url);
  const { pathname } = url;
  // A path starting with // would name another origin; no page lives there.
  if (!pathname.startsWith(app.base) || pathname.startsWith("//")) return app.notFound(request, payload);
  // The redirects option precedes pages, with or without the trailing slash.
  const redirect = app.redirects.get(pathname.endsWith("/") ? pathname : pathname + "/");
  if (redirect !== undefined) return pageResponse({ ...redirect, body: "", head: { html: "" }, layers: [] }, request, payload);
  // Endpoints answer paths without a trailing slash, which pages redirect from.
  if (!payload && !pathname.endsWith("/")) {
    const endpoint = matchRoute(app.endpoints, pathname, app.base);
    if (endpoint !== undefined) return answerEndpoint(app, endpoint.route, endpoint.params, request);
  }
  const matched = matchRoute(app.routes, pathname, app.base);
  if (matched === undefined) return app.notFound(request, payload);
  // A POST is a form submission, which a page's actions answer.
  if (!["GET", "HEAD", "POST"].includes(request.method)) return new Response(null, { status: 405, headers: { allow: "GET, HEAD" } });
  if (!pathname.endsWith("/")) return new Response(null, { status: 308, headers: { location: pathname + "/" + url.search } });
  if (request.method === "POST" && !sameOrigin(request)) return new Response("Cross-origin form submissions are refused.", { status: 403 });
  return app.page(matched.route, matched.params, request, payload);
}

/**
 * Whether a request comes from a page of this site, as Go's CrossOriginProtection decides: by
 * Sec-Fetch-Site, or by Origin from browsers that don't send it. A request with neither isn't a
 * browser's cross-site form, such as one from curl.
 */
function sameOrigin(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site !== null) return site === "same-origin" || site === "none";
  const origin = request.headers.get("origin");
  // Hosts, not origins: behind a TLS proxy the request's own URL is http.
  return origin === null || URL.parse(origin)?.host === new URL(request.url).host;
}

/** The action a page's POST names, `?/name` or `default`, or the answer that refuses it: 405 for a page without actions, 404 for an unknown name. */
export function pageAction(module: ServerModule, url: URL): PageAction | Response {
  const { actions } = module;
  if (actions === undefined) return new Response(null, { status: 405, headers: { allow: "GET, HEAD" } });
  const name = [...url.searchParams.keys()].find(key => key.startsWith("/"))?.slice(1) ?? "default";
  const action = Object.hasOwn(actions, name) ? actions[name] : undefined;
  return typeof action === "function" ? action : new Response(null, { status: 404 });
}

/** The build error for actions on a page that prerenders. */
export function prerenderedActions(pattern: string, origin: string): HtmlKitError {
  return new HtmlKitError(`The page ${pattern} has actions, which answer requests; <meta name="hk:render" content="server"> renders it on each request.`, origin);
}

async function answerEndpoint<Route extends NavigationRoute>(app: Pipeline<Route>, endpoint: EndpointRoute, params: Params, request: Request): Promise<Response> {
  const module = await app.endpoint(endpoint);
  const method = methods.find(name => name === request.method);
  // HEAD answers with GET's headers unless the file exports its own.
  const handler = method === undefined ? undefined : module[method] ?? (method === "HEAD" ? module.GET : undefined);
  if (typeof handler !== "function") {
    const allow = methods.filter(name => typeof module[name] === "function" || name === "HEAD" && typeof module.GET === "function");
    return new Response(null, { status: 405, headers: { allow: allow.join(", ") } });
  }
  const response: unknown = await handler(request, { params });
  if (!(response instanceof Response)) throw new HtmlKitError(`${method!} must return a Response.`, endpoint.file);
  return method === "HEAD" && module.HEAD === undefined ? new Response(null, response) : response;
}

/** A build's request server data, which the build writes into _htmlkit/server/entry.js. */
export interface ServerData {
  readonly version: 2;
  readonly base: string;
  readonly redirects: readonly ManifestRedirect[];
  readonly routes: readonly NavigationRoute[];
  /** Each concrete page URL and its route's index, for navigation. */
  readonly catalog: readonly (readonly [string, number])[];
  readonly scripts: readonly string[];
  /** The site's Content Security Policy, unless csp is false. */
  readonly policy?: RenderedPolicy;
  /** What starts an alias page's canonical link: the configured origin, or "" without one. */
  readonly canonicalOrigin: string;
  /** Each server-rendered route, by its index in routes. */
  readonly pages: Readonly<Record<string, ServerPage>>;
  /** app/error.html, which answers a failed request, when anything renders on request. */
  readonly error?: ServerPage & { readonly route: NavigationRoute };
  readonly endpoints: readonly (EndpointRoute & { readonly module: string })[];
  readonly middleware?: string;
}
/** A route the server renders: each layer's component and loader module, every component they use, and their browser delivery. */
export interface ServerPage {
  readonly layers: readonly { readonly definition: ComponentDefinition; readonly module?: string; readonly origin: string }[];
  readonly definitions: readonly ComponentDefinition[];
  readonly assets: PageAssets;
}

export const mime: Readonly<Record<string, string>> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
  ".webp": "image/webp", ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml" };

/**
 * What a path names in a build's output: a file, a directory's index.html (page), a directory without its
 * trailing slash ("slash"), an undecodable path ("invalid"), or nothing. Nothing outside the output resolves.
 */
export async function outputPath(output: string, base: string, pathname: string): Promise<{ readonly file: string; readonly page: boolean } | "slash" | "invalid" | undefined> {
  if (base !== "/" && pathname === base.slice(0, -1)) return "slash";
  if (!pathname.startsWith(base)) return undefined;
  let decoded: string;
  try { decoded = decodeURIComponent(pathname.slice(base.length)); } catch { return "invalid"; }
  const candidate = resolve(output, decoded || ".");
  if (!within(output, candidate)) return undefined;
  try {
    let file = await realpath(candidate);
    if (!within(output, file)) return undefined;
    const page = (await stat(file)).isDirectory();
    if (page) {
      if (!pathname.endsWith("/")) return "slash";
      file = await realpath(join(file, "index.html"));
      if (!within(output, file)) return undefined;
    }
    return { file, page };
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code!)) return undefined;
    throw error;
  }
}


/**
 * The application a build's server entry exports: data and module loaders the build wrote, and the
 * output directory two levels above the entry. Prerendered pages and assets come from the output's files.
 */
export async function serverApplication(entry: string, data: ServerData, modules: Readonly<Record<string, () => Promise<unknown>>>): Promise<ServerApplication> {
  if (data.version !== 2) throw new HtmlKitError(`Unsupported server entry version ${String(data.version)}; rebuild with this HTMLKit.`, entry);
  const output = await realpath(fileURLToPath(new URL("../../", entry)));
  const { base, routes } = data;
  const load = async <Module>(id: string) => await modules[id]!() as Module;
  const catalog = new Map(data.catalog.map(([path, index]) => [path, routes[index]!]));
  const navigation = createNavigation(base, routes, () => Promise.resolve(catalog));
  // Files that are never served: the server's own code, and payloads, which answer through their pages.
  const reserved = [join(output, "_htmlkit/server"), join(output, "_htmlkit/pages")];
  // A prerendered page's file carries the site's policy as a header too, which may hold header-only directives.
  const file = async (path: string, request: Request, status = 200, init?: Headers, page = false) => {
    const headers = new Headers(init);
    headers.set("content-type", mime[extname(path)] ?? "application/octet-stream");
    if (page && data.policy !== undefined) headers.set(policyHeader(data.policy), data.policy.header);
    // Hashed bundles beside the manifest never change.
    if (/^_htmlkit\/[^/]+$/.test(path.slice(output.length + 1).replaceAll("\\", "/")) && !path.endsWith("manifest.json")) headers.set("cache-control", "public, max-age=31536000, immutable");
    return new Response(request.method === "HEAD" ? null : await readFile(path), { status, headers });
  };
  const missing = (request: Request, headers?: Headers) => file(join(output, "404.html"), request, 404, headers, true);
  const render = (page: ServerPage, route: NavigationRoute, params: Params, url: URL, request: Request | undefined, signal: AbortSignal, failure?: Failure, action?: PageAction) =>
    renderRoute({ base, canonicalOrigin: data.canonicalOrigin, route, params, url, ...(request === undefined ? {} : { request }), signal, definitions: page.definitions,
      scripts: data.scripts, ...(data.policy === undefined ? {} : { policy: data.policy }), navigation, ...(failure === undefined ? {} : { failure }), ...(action === undefined ? {} : { action }),
      layers: page.layers.map(layer => ({ ...layer, module: () => layer.module === undefined ? Promise.resolve({}) : load<ServerModule>(layer.module) })) });
  // A failure answers with app/error.html, rendered as the build would render it, and a safe message; the error goes to the console.
  const failed = async (error: unknown, request: Request): Promise<Response> => {
    if (!request.signal.aborted) console.error(error);
    const { pathname } = new URL(request.url);
    // A failed page has no payload, so the browser loads its document, the error page.
    if (pathname.startsWith(base + "_htmlkit/pages/")) return new Response(null, { status: 500 });
    const builtin = () => pageResponse({ ...failurePage(serverFailure, data.scripts, data.policy), layers: [] }, request, false);
    if (data.error === undefined || pathname.startsWith("//")) return builtin();
    try {
      const rendered = await render(data.error, data.error.route, {}, new URL(pathname, request.url), undefined, request.signal, serverFailure);
      return rendered.kind === "page" ? pageResponse({ ...rendered, status: serverFailure.status }, request, false, data.error.assets) : builtin();
    } catch (again) {
      // The error page shares the site's layouts, so a failing layout fails it too; the built-in page answers then.
      if (!request.signal.aborted) console.error(again);
      return builtin();
    }
  };
  const pipeline: Pipeline<NavigationRoute> = {
    base, routes, endpoints: data.endpoints,
    redirects: new Map(data.redirects.map(({ from, to, status }) => [from, { location: to, status }])),
    endpoint: route => load<EndpointModule>((route as typeof data.endpoints[number]).module),
    ...(data.middleware === undefined ? {} : { middleware: async () => (await load<{ default: Middleware }>(data.middleware!)).default }),
    async page(route, params, request, payload) {
      const server = data.pages[routes.indexOf(route)];
      const url = new URL(request.url);
      // The build refuses actions on a prerendered page.
      let action: PageAction | undefined;
      if (request.method === "POST") {
        const module = server?.layers.at(-1)!.module;
        const found = pageAction(module === undefined ? {} : await load<ServerModule>(module), url);
        if (found instanceof Response) return found;
        action = found;
      }
      if (server === undefined) {
        // A prerendered page: its document or payload, if the build wrote one for this URL.
        const found = await outputPath(output, base, payload ? `${base}_htmlkit/pages/${url.pathname.slice(base.length)}payload.json` : url.pathname);
        if (typeof found === "object") return file(found.file, request, 200, undefined, !payload);
        return payload ? new Response(null, { status: 404 }) : missing(request);
      }
      const rendered = await render(server, route, params, url, request, request.signal, undefined, action);
      if (rendered.kind === "notFound") return payload ? new Response(null, { status: 404, headers: rendered.headers }) : missing(request, rendered.headers);
      return pageResponse(rendered.kind === "page" ? rendered : { ...rendered, body: "", head: { html: "" }, layers: [] }, request, payload, server.assets);
    },
    async notFound(request, payload) {
      if (payload) return new Response(null, { status: 404 });
      // A directory of public files is served as a static host serves it.
      const found = await outputPath(output, base, new URL(request.url).pathname);
      if (found === "slash") return new Response(null, { status: 308, headers: { location: new URL(request.url).pathname + "/" } });
      return typeof found === "object" && found.page && !reserved.some(path => within(path, found.file)) ? file(found.file, request) : missing(request);
    },
  };
  return {
    base,
    async fetch(request) {
      try {
        // Files answer before middleware: a page's directory, and an endpoint's path, go through it.
        const found = await outputPath(output, base, new URL(request.url).pathname);
        if (typeof found === "object" && !found.page && !reserved.some(path => within(path, found.file))) {
          return request.method === "GET" || request.method === "HEAD" ? await file(found.file, request) : new Response(null, { status: 405, headers: { allow: "GET, HEAD" } });
        }
        return await respond(pipeline, request);
      } catch (error) { return failed(error, request); }
    },
  };
}

/** A native Request for a Node request: its method, URL, headers, and body, aborted when the response closes. */
export function nodeRequest(incoming: IncomingMessage, outgoing: ServerResponse): Request {
  const controller = new AbortController();
  outgoing.once("close", () => controller.abort());
  const headers = new Headers();
  for (let i = 0; i < incoming.rawHeaders.length; i += 2) headers.append(incoming.rawHeaders[i]!, incoming.rawHeaders[i + 1]!);
  // Vite's development server keeps the path under its base in originalUrl.
  const path = "originalUrl" in incoming && typeof incoming.originalUrl === "string" ? incoming.originalUrl : incoming.url ?? "/";
  const method = incoming.method ?? "GET";
  // ponytail: http and the Host header; a proxy's X-Forwarded-* headers are not read.
  return new Request(`http://${incoming.headers.host ?? "localhost"}${path}`, { method, headers, signal: controller.signal,
    ...(method === "GET" || method === "HEAD" ? {} : { body: Readable.toWeb(incoming) as ReadableStream<Uint8Array>, duplex: "half" }) } as RequestInit);
}

/** Write a Response to a Node response, streaming its body. */
export async function sendResponse(response: Response, outgoing: ServerResponse): Promise<void> {
  const headers: Record<string, string | string[]> = {};
  for (const [name, value] of response.headers) if (name !== "set-cookie") headers[name] = value;
  const cookies = response.headers.getSetCookie();
  if (cookies.length > 0) headers["set-cookie"] = cookies;
  outgoing.writeHead(response.status, headers);
  if (response.body === null) { outgoing.end(); return; }
  // A reader that goes away ends the stream; there is no one left to answer.
  await pipeline(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream), outgoing).catch(() => { outgoing.destroy(); });
}

export async function listen(server: Server, options: { readonly host?: string; readonly port?: number }, base: string): Promise<ApplicationServer> {
  const host = options.host ?? "127.0.0.1";
  await new Promise<void>((done, reject) => { server.once("error", reject); server.listen(options.port ?? 3000, host, done); });
  const address = server.address();
  if (address === null || typeof address === "string") throw new HtmlKitError("Server did not obtain a TCP port.");
  return { url: `http://${host.includes(":") ? `[${host}]` : host}:${address.port}${base}`,
    close: () => new Promise<void>((done, reject) => { server.close(error => error ? reject(error) : done()); server.closeIdleConnections(); }) };
}

/** Serve a build's server entry on Node: `htmlkit start`. */
export async function startApplication(options: StartOptions = {}): Promise<ApplicationServer> {
  if (options.renderWorkers !== undefined) setRenderWorkers(options.renderWorkers);
  const entry = pathToFileURL(resolve(options.outDir ?? "dist", "_htmlkit/server/entry.js"));
  try { await stat(entry); }
  catch { throw new HtmlKitError("No server entry; run htmlkit build first.", fileURLToPath(entry)); }
  const application = (await import(entry.href) as { default: ServerApplication }).default;
  const server = createHTTPServer((incoming, outgoing) => {
    void (async () => {
      let request: Request;
      try { request = nodeRequest(incoming, outgoing); }
      catch { outgoing.writeHead(400).end(); return; }
      await sendResponse(await application.fetch(request), outgoing);
    })().catch(error => {
      console.error(error);
      if (outgoing.headersSent) outgoing.end();
      else outgoing.writeHead(500, { "content-type": "text/html; charset=utf-8" }).end(failurePage(serverFailure, []).html);
    });
  });
  return listen(server, options, application.base);
}
