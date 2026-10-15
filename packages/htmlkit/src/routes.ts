import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { HtmlKitError, within } from "./config.js";
import { applicationResource, pageDefinition } from "./resource.js";
import type { ApplicationOptions, ApplicationRoute, HtmlKitPlugin, RouteGroup, RouteInput, RouteLayer } from "./types.js";

/** The name of a [name], [...name] catch-all, or [[...name]] optional catch-all segment. */
export function parameter(segment: string): string | undefined {
  const match = /^\[(?:\.\.\.)?([A-Za-z][A-Za-z0-9_]*)\]$|^\[\[\.\.\.([A-Za-z][A-Za-z0-9_]*)\]\]$/.exec(segment);
  return match?.[1] ?? match?.[2];
}
/** How broadly a segment matches: 0 a literal, 1 [name], 2 [...name], 3 [[...name]]. A missing segment is -1. */
export function breadth(segment: string | undefined): number {
  if (segment === undefined) return -1;
  return parameter(segment) === undefined ? 0 : segment.startsWith("[[") ? 3 : segment.startsWith("[...") ? 2 : 1;
}
export function validSegment(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value !== "." && value !== ".." && !value.includes("/") && !/[\\\0?#]/.test(value);
}
export const redirectStatuses: readonly number[] = [301, 302, 303, 307, 308];
/** A redirect's Location: an application path, under base, or an absolute http(s) URL. */
export function redirectLocation(base: string, to: unknown, source: string): string {
  if (typeof to === "string" && /^\/(?![/\\])/.test(to)) return base + to.slice(1);
  try { if (typeof to === "string" && /^https?:$/.test(new URL(to).protocol)) return new URL(to).href; } catch { /* Reported below. */ }
  throw new HtmlKitError(`Redirect target ${String(to)} must be an application path starting with / or an http(s) URL.`, source);
}
/** The redirects option by deployment pathname, each to its Location. */
export function redirectTable(base: string, redirects: Readonly<Record<string, string>> = {}): ReadonlyMap<string, string> {
  const table = new Map<string, string>();
  for (const [from, to] of Object.entries(redirects)) {
    const segments = from.slice(1, -1).split("/").filter(Boolean);
    if (!/^\/(?:[^/]+\/)*$/.test(from) || segments[0] === "_htmlkit" || !segments.every(validSegment)) {
      throw new HtmlKitError("Redirects need application paths with leading and trailing slashes, outside _htmlkit.", from);
    }
    table.set(new URL(base + from.slice(1), "http://localhost").pathname, redirectLocation(base, to, from));
  }
  return table;
}
type DiscoveryOptions = Pick<ApplicationOptions, "base" | "routes" | "fileRoutes" | "pages" | "layout" | "layoutDefaults" | "plugins">;

export async function discoverRoutes(root = process.cwd(), options: DiscoveryOptions = {}): Promise<readonly ApplicationRoute[]> {
  return (await discover(root, options)).routes;
}

/**
 * Routes plus what page plugins produced: compiled page sources by component path, and the files
 * pages reference, by deployment-relative path.
 */
export async function discover(root: string, options: DiscoveryOptions) {
  const base = options.base ?? "/";
  const compilers = new Map<string, NonNullable<HtmlKitPlugin["pages"]>>();
  for (const plugin of options.plugins ?? []) {
    for (const extension of plugin.pages?.extensions ?? []) {
      if (!/^\.[A-Za-z0-9]+$/.test(extension) || extension === ".html" || compilers.has(extension)) {
        throw new HtmlKitError(`Page extension ${extension} must be a unique .name other than .html.`, plugin.name);
      }
      compilers.set(extension, plugin.pages!);
    }
  }
  const pageExtension = (name: string) => [".html", ...compilers.keys()].find(extension => name.endsWith(extension) && name.length > extension.length);
  // Each route remembers its page directory's prefix, which page aliases are relative to.
  // folderLayouts are the _layout.html files from the page directory down to the page, outermost first.
  const routes: (Omit<ApplicationRoute, "pageName"> & { readonly prefix: string; readonly directoryLayout?: string | false | RouteLayer;
    readonly folderLayouts: readonly RouteLayer[]; readonly notFound?: true })[] = [];
  const add = (input: RouteInput & { readonly canonical?: string; readonly notFound?: true }, prefix: string, order?: readonly (string | null)[],
    directoryLayout?: string | false | RouteLayer, folderLayouts: readonly RouteLayer[] = [], groups: readonly RouteGroup[] = []): void => {
    if (!/^\/(?:[^/]+\/)*$/.test(input.pattern)) throw new HtmlKitError("Route patterns require leading and trailing slashes.", input.component);
    const segments = input.pattern.slice(1, -1).split("/").filter(Boolean);
    if (segments[0] === "_htmlkit") throw new HtmlKitError("_htmlkit is reserved for generated assets.", input.component);
    if (segments.some(segment => parameter(segment) === undefined && !/^[A-Za-z0-9_-]+$/.test(segment))) {
      throw new HtmlKitError("Route segments must be URL slugs or [named] parameters.", input.component);
    }
    if (segments.slice(0, -1).some(segment => breadth(segment) > 1)) throw new HtmlKitError("A [...catch-all] parameter must be the last route segment.", input.component);
    const params = segments.flatMap(segment => parameter(segment) ?? []);
    if (new Set(params).size !== params.length) throw new HtmlKitError("Route parameter names must be unique.", input.component);
    const absolute = (layer: RouteLayer): RouteLayer => ({ component: resolve(root, layer.component),
      ...(layer.server === undefined ? {} : { server: typeof layer.server === "string" ? resolve(root, layer.server) : layer.server }) });
    routes.push({ ...absolute(input), pattern: input.pattern, segments, params, layouts: (input.layouts ?? []).map(absolute), prefix, folderLayouts,
      ...(directoryLayout === undefined ? {} : { directoryLayout }), ...(groups.length === 0 ? {} : { groups }),
      ...(order === undefined ? {} : { order }), ...(input.canonical === undefined ? {} : { canonical: input.canonical }),
      ...(input.notFound ? { notFound: true as const } : {}) });
  };
  // A number and a dot ("01.guide") order a file or directory and stay out of its URL. Route
  // segments cannot contain dots, so the prefix is never part of a name.
  const ordered = (name: string, source: string) => {
    const prefix = /^(\d+)\.(.*)$/.exec(name);
    if (prefix?.[2] === "") throw new HtmlKitError("Ordering prefix leaves an empty route segment.", source);
    return { slug: prefix?.[2] ?? name, rank: prefix?.[1] ?? null };
  };
  const visit = async (directory: string, prefix: string, segments: string[], order: (string | null)[],
    directoryLayout: string | false | RouteLayer | undefined, outer: readonly RouteLayer[], groups: readonly RouteGroup[]): Promise<void> => {
    const files = await readdir(directory, { withFileTypes: true });
    const names = new Set(files.filter(file => file.isFile()).map(file => file.name));
    const layer = (name: string, stem: string): RouteLayer => {
      const servers = ["ts", "js"].filter(ext => names.has(`${stem}.server.${ext}`));
      if (servers.length > 1) throw new HtmlKitError(`Choose one ${stem}.server.ts or .js loader.`, directory);
      return { component: join(directory, name), ...(servers[0] === undefined ? {} : { server: join(directory, `${stem}.server.${servers[0]}`) }) };
    };
    // A folder's _layout.html wraps its pages and its subfolders' pages, inside its parents' layouts.
    const folderLayouts = names.has("_layout.html") ? [...outer, layer("_layout.html", "_layout")] : outer;
    for (const name of [...names].sort()) {
      const extension = pageExtension(name);
      if (extension === undefined || name.startsWith("_") || name.startsWith(".")) continue;
      const stem = name.slice(0, -extension.length);
      const { slug, rank } = ordered(stem, join(directory, name));
      const parts = slug === "index" ? segments : [...segments, slug];
      // A 404 page at the root of the application's pages is the not-found page, not a /404/ route.
      const notFound = parts.length === 1 && parts[0] === "404";
      add({ ...layer(name, stem), pattern: `/${parts.length === 0 ? "" : parts.join("/") + "/"}`, ...(notFound ? { notFound: true as const } : {}) },
        prefix, slug === "index" ? order : [...order, rank], directoryLayout, folderLayouts, groups);
    }
    for (const file of files.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!file.isDirectory() || file.name.startsWith(".") || file.name.startsWith("_")) continue;
      const { slug, rank } = ordered(file.name, join(directory, file.name));
      // A (group) folder orders and labels its pages and adds no URL segment.
      const label = /^\(([^()]*)\)$/.exec(slug)?.[1];
      if (label !== undefined) {
        if (label.trim() === "") throw new HtmlKitError("A route group needs a label inside its parentheses.", join(directory, file.name));
        await visit(join(directory, file.name), prefix, segments, order, directoryLayout, folderLayouts, [...groups, { label, order: rank, depth: segments.length }]);
        continue;
      }
      if (parameter(slug) === undefined && !/^[A-Za-z0-9_-]+$/.test(slug)) {
        throw new HtmlKitError("Route directories must be URL slugs, [named] parameters, or (groups).", join(directory, file.name));
      }
      await visit(join(directory, file.name), prefix, [...segments, slug], [...order, rank], directoryLayout, folderLayouts, groups);
    }
  };
  if (options.fileRoutes !== false) {
    for (const { dir, prefix = "/", layout, optional } of options.pages ?? [{ dir: "app/pages", optional: true }]) {
      if (!/^\/(?:[A-Za-z0-9_-]+\/)*$/.test(prefix)) throw new HtmlKitError("Page directory prefixes need leading and trailing slashes around URL slugs.", dir);
      const directory = resolve(root, dir);
      if (!within(root, directory)) throw new HtmlKitError("Page directories must be inside the application root.", directory);
      let present = true;
      try { await stat(directory); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; present = false; }
      // app/pages is optional; a configured directory must exist.
      if (!present && !optional) throw new HtmlKitError("Page directory does not exist.", directory);
      const segments = prefix.split("/").filter(Boolean);
      if (present) await visit(directory, prefix, segments, segments.map(() => null), layout, [], []);
    }
  }
  for (const route of options.routes ?? []) add(route, "/");

  // A plugin page links to another page's first static URL, and serves the files it references.
  const pageURLs = new Map<string, string>();
  for (const route of routes) if (route.params.length === 0 && !route.notFound && !pageURLs.has(route.component)) pageURLs.set(route.component, base + route.pattern.slice(1));
  const realRoot = await realpath(root);
  const sources = new Map<string, string>();
  const files = new Map<string, string>();
  const pageFiles = new Map<string, ReturnType<typeof applicationResource>>();
  const resourceOf = async (component: string) => {
    const identity = await realpath(component);
    let resource = pageFiles.get(identity);
    if (resource !== undefined) return { identity, resource };
    // Read declarations only. Route discovery never executes loaders or controllers.
    let text = await readFile(identity, "utf8");
    const compiler = compilers.get(pageExtension(component) ?? ".html");
    if (compiler !== undefined) {
      text = await compiler.compile(text, { file: component,
        href: target => pageURLs.get(resolve(target)),
        asset(file) {
          const absolute = resolve(file);
          let real: string;
          // The native resolver, as for the root: on Windows the JS one keeps 8.3 short names (RUNNER~1).
          try { real = realpathSync.native(absolute); } catch { throw new HtmlKitError(`Missing asset ${file}.`, component); }
          if (!within(realRoot, real) || !statSync(real).isFile()) throw new HtmlKitError(`Asset ${file} must be a file inside the application root.`, component);
          // Never publish what a stray reference could name: dotfiles and dot folders (.env, .git) or keys.
          if (relative(realRoot, real).split(sep).some(part => part.startsWith(".")) || /\.(?:pem|crt|key)$/i.test(real)) {
            throw new HtmlKitError(`Asset ${file} is private: dotfiles, dot folders, keys, and certificates are never published.`, component);
          }
          const name = `_htmlkit/files/${createHash("sha256").update(relative(realRoot, real)).digest("hex").slice(0, 16)}-${basename(real)}`;
          files.set(name, real);
          return base + name.split("/").map(encodeURIComponent).join("/");
        } });
      sources.set(component, text);
    }
    resource = applicationResource(text, pathToFileURL(identity).href);
    pageFiles.set(identity, resource);
    return { identity, resource };
  };
  // Page aliases are further routes for the same page, relative to its page directory. The loop
  // also reaches the aliases it appends, which it skips.
  for (const route of routes) {
    if (route.canonical !== undefined || route.notFound) continue;
    const { resource } = await resourceOf(route.component);
    for (const alias of resource.components.get(pageDefinition(resource, route.component).contract.tag)!.aliases) {
      if (!/^\/(?:[^/]+\/)*$/.test(alias)) throw new HtmlKitError("hk:alias needs a route path with leading and trailing slashes.", route.component);
      add({ component: route.component, ...(route.server === undefined ? {} : { server: route.server }), layouts: route.layouts,
        pattern: route.prefix + alias.slice(1), canonical: route.pattern }, route.prefix, undefined, route.directoryLayout, route.folderLayouts);
    }
  }
  for (const prefix of Object.keys(options.layoutDefaults ?? {})) {
    if (!/^\/(?:[^/]+\/)*$/.test(prefix)) throw new HtmlKitError("Layout defaults require route-directory prefixes with leading and trailing slashes.", prefix);
  }
  const patterns = new Map<string, string>();
  for (const route of routes) {
    const normalized = route.segments.map(segment => ["", "[]", "[...]", "[[...]]"][breadth(segment)] || segment.toLowerCase()).join("/");
    if (patterns.has(normalized)) throw new HtmlKitError(`Route conflict: ${patterns.get(normalized)} and ${route.component} (${route.pattern}).`, route.component);
    patterns.set(normalized, `${route.component} (${route.pattern})`);
  }
  const pageNames = new Map<string, { component: string; pattern: string; identity: string }>();
  const discovered: ApplicationRoute[] = [];
  let notFound: ApplicationRoute | undefined;
  const layoutDefaults = Object.entries(options.layoutDefaults ?? {}).sort(([a], [b]) => b.length - a.length);
  for (const { prefix: _prefix, directoryLayout, folderLayouts, notFound: isNotFound, ...route } of routes) {
    const { identity, resource } = await resourceOf(route.component);
    const pageName = pageDefinition(resource, route.component).contract.tag;
    const previous = pageNames.get(pageName);
    if (previous !== undefined && previous.identity !== identity) {
      throw new HtmlKitError(`Duplicate page component <${pageName}>: ${previous.component} (${previous.pattern}) and ${route.component} (${route.pattern}).`, route.component);
    }
    pageNames.set(pageName, { component: route.component, pattern: route.pattern, identity });
    const metadata = resource.components.get(pageName)!;
    // An alias is a further URL for its page, so it takes the layout of the page's own URL.
    const directory = layoutDefaults.find(([prefix]) => (route.canonical ?? route.pattern).startsWith(prefix));
    let selected = metadata.layout ?? directoryLayout ?? directory?.[1] ?? options.layout;
    if (selected === undefined && route.layouts.length === 0) {
      try { await stat(resolve(root, "app/layouts/default.html")); selected = "default"; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    let layouts = route.layouts;
    if (selected === false || selected === "none") layouts = [];
    else if (typeof selected === "object") {
      layouts = [{ component: resolve(root, selected.component),
        ...(selected.server === undefined ? {} : { server: typeof selected.server === "string" ? resolve(root, selected.server) : selected.server }) }];
    } else if (selected !== undefined) {
      if (!/^[A-Za-z0-9_-]+$/.test(selected)) throw new HtmlKitError("Layout names must be filename slugs.", route.component);
      const component = resolve(root, `app/layouts/${selected}.html`);
      await stat(component);
      const servers: string[] = [];
      for (const extension of ["ts", "js"]) {
        const candidate = resolve(root, `app/layouts/${selected}.server.${extension}`);
        try { await stat(candidate); servers.push(candidate); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
      if (servers.length > 1) throw new HtmlKitError("Choose one layout .server.ts or .js loader.", component);
      layouts = [{ component, ...(servers[0] === undefined ? {} : { server: servers[0] }) }];
    }
    // The selected layout is outermost and folder layouts nest inside it; none drops them all.
    if (selected !== false && selected !== "none") layouts = [...layouts, ...folderLayouts];
    const discoveredRoute = { ...route, layouts, pageName, ...(metadata.label === undefined ? {} : { label: metadata.label }),
      ...(metadata.hidden ? { hidden: true } : {}) };
    if (isNotFound) notFound = discoveredRoute;
    else discovered.push(discoveredRoute);
  }
  return { routes: discovered, ...(notFound === undefined ? {} : { notFound }), sources, files };
}
export function matchRoute(routes: readonly ApplicationRoute[], pathname: string, base: string) {
  if (!pathname.startsWith(base)) return undefined;
  let segments: string[];
  try { segments = pathname.slice(base.length).replace(/\/$/, "").split("/").filter(Boolean).map(decodeURIComponent); }
  catch { return undefined; }
  if (segments.some(segment => !validSegment(segment))) return undefined;
  // Segment by segment, a literal precedes [name], which precedes [...name], which precedes
  // [[...name]]; never depend on filesystem order.
  const sorted = [...routes].sort((a, b) => {
    for (let i = 0; i < Math.max(a.segments.length, b.segments.length); i++) {
      const difference = breadth(a.segments[i]) - breadth(b.segments[i]);
      if (difference !== 0) return difference;
    }
    return a.pattern.localeCompare(b.pattern);
  });
  for (const route of sorted) {
    // A catch-all takes the remaining segments: at least one, or any number for [[...name]].
    const rest = Math.max(0, breadth(route.segments.at(-1)) - 1);
    const fixed = rest === 0 ? route.segments.length : route.segments.length - 1;
    if (rest === 0 ? segments.length !== fixed : segments.length < fixed + 2 - rest) continue;
    const params: Record<string, string | readonly string[]> = {};
    if (route.segments.slice(0, fixed).every((segment, index) => {
      const name = parameter(segment);
      if (name === undefined) return segment === segments[index];
      params[name] = segments[index]!;
      return true;
    })) {
      if (rest > 0) params[parameter(route.segments.at(-1)!)!] = Object.freeze(segments.slice(fixed));
      return { route, params: Object.freeze(params) };
    }
  }
  return undefined;
}
