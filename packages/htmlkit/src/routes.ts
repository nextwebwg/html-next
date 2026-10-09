import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { HtmlKitError, within } from "./config.js";
import { applicationResource, pageDefinition } from "./resource.js";
import type { ApplicationOptions, ApplicationRoute, HtmlKitPlugin, RouteInput, RouteLayer } from "./types.js";

export function parameter(segment: string): string | undefined { return /^\[([A-Za-z][A-Za-z0-9_]*)\]$/.exec(segment)?.[1]; }
export function validSegment(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value !== "." && value !== ".." && !value.includes("/") && !/[\\\0?#]/.test(value);
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
  const routes: (Omit<ApplicationRoute, "pageName"> & { readonly prefix: string })[] = [];
  const add = (input: RouteInput & { readonly canonical?: string }, prefix: string, order?: readonly (string | null)[]): void => {
    if (!/^\/(?:[^/]+\/)*$/.test(input.pattern)) throw new HtmlKitError("Route patterns require leading and trailing slashes.", input.component);
    const segments = input.pattern.slice(1, -1).split("/").filter(Boolean);
    if (segments[0] === "_htmlkit") throw new HtmlKitError("_htmlkit is reserved for generated assets.", input.component);
    if (segments.some(segment => parameter(segment) === undefined && !/^[A-Za-z0-9_-]+$/.test(segment))) {
      throw new HtmlKitError("Route segments must be URL slugs or [named] parameters.", input.component);
    }
    const params = segments.flatMap(segment => parameter(segment) ?? []);
    if (new Set(params).size !== params.length) throw new HtmlKitError("Route parameter names must be unique.", input.component);
    const absolute = (layer: RouteLayer): RouteLayer => ({ component: resolve(root, layer.component),
      ...(layer.server === undefined ? {} : { server: typeof layer.server === "string" ? resolve(root, layer.server) : layer.server }) });
    routes.push({ ...absolute(input), pattern: input.pattern, segments, params, layouts: (input.layouts ?? []).map(absolute), prefix,
      ...(order === undefined ? {} : { order }), ...(input.canonical === undefined ? {} : { canonical: input.canonical }) });
  };
  // A number and a dot ("01.guide") order a file or directory and stay out of its URL. Route
  // segments cannot contain dots, so the prefix is never part of a name.
  const ordered = (name: string, source: string) => {
    const prefix = /^(\d+)\.(.*)$/.exec(name);
    if (prefix?.[2] === "") throw new HtmlKitError("Ordering prefix leaves an empty route segment.", source);
    return { slug: prefix?.[2] ?? name, rank: prefix?.[1] ?? null };
  };
  const visit = async (directory: string, prefix: string, segments: string[], order: (string | null)[]): Promise<void> => {
    const files = await readdir(directory, { withFileTypes: true });
    const names = new Set(files.filter(file => file.isFile()).map(file => file.name));
    const layer = (name: string, stem: string): RouteLayer => {
      const servers = ["ts", "js"].filter(ext => names.has(`${stem}.server.${ext}`));
      if (servers.length > 1) throw new HtmlKitError(`Choose one ${stem}.server.ts or .js loader.`, directory);
      return { component: join(directory, name), ...(servers[0] === undefined ? {} : { server: join(directory, `${stem}.server.${servers[0]}`) }) };
    };
    for (const name of [...names].sort()) {
      const extension = pageExtension(name);
      if (extension === undefined || name.startsWith("_") || name.startsWith(".")) continue;
      const stem = name.slice(0, -extension.length);
      const { slug, rank } = ordered(stem, join(directory, name));
      const parts = slug === "index" ? segments : [...segments, slug];
      add({ ...layer(name, stem), pattern: `/${parts.length === 0 ? "" : parts.join("/") + "/"}` }, prefix, slug === "index" ? order : [...order, rank]);
    }
    for (const file of files.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!file.isDirectory() || file.name.startsWith(".") || file.name.startsWith("_")) continue;
      const { slug, rank } = ordered(file.name, join(directory, file.name));
      if (parameter(slug) === undefined && !/^[A-Za-z0-9_-]+$/.test(slug)) {
        throw new HtmlKitError("Route directories must be URL slugs or [named] parameters.", join(directory, file.name));
      }
      await visit(join(directory, file.name), prefix, [...segments, slug], [...order, rank]);
    }
  };
  if (options.fileRoutes !== false) {
    for (const { dir, prefix = "/" } of options.pages ?? [{ dir: "app/pages" }]) {
      if (!/^\/(?:[A-Za-z0-9_-]+\/)*$/.test(prefix)) throw new HtmlKitError("Page directory prefixes need leading and trailing slashes around URL slugs.", dir);
      const directory = resolve(root, dir);
      if (!within(root, directory)) throw new HtmlKitError("Page directories must be inside the application root.", directory);
      let present = true;
      try { await stat(directory); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; present = false; }
      // app/pages is optional; a configured directory must exist.
      if (!present && options.pages !== undefined) throw new HtmlKitError("Page directory does not exist.", directory);
      const segments = prefix.split("/").filter(Boolean);
      if (present) await visit(directory, prefix, segments, segments.map(() => null));
    }
  }
  for (const route of options.routes ?? []) add(route, "/");

  // A plugin page links to another page's first static URL, and serves the files it references.
  const pageURLs = new Map<string, string>();
  for (const route of routes) if (route.params.length === 0 && !pageURLs.has(route.component)) pageURLs.set(route.component, base + route.pattern.slice(1));
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
    if (route.canonical !== undefined) continue;
    const { resource } = await resourceOf(route.component);
    for (const alias of resource.components.get(pageDefinition(resource, route.component).contract.tag)!.aliases) {
      if (!/^\/(?:[^/]+\/)*$/.test(alias)) throw new HtmlKitError("hk:alias needs a route path with leading and trailing slashes.", route.component);
      add({ component: route.component, ...(route.server === undefined ? {} : { server: route.server }), layouts: route.layouts,
        pattern: route.prefix + alias.slice(1), canonical: route.pattern }, route.prefix);
    }
  }
  for (const prefix of Object.keys(options.layoutDefaults ?? {})) {
    if (!/^\/(?:[^/]+\/)*$/.test(prefix)) throw new HtmlKitError("Layout defaults require route-directory prefixes with leading and trailing slashes.", prefix);
  }
  const patterns = new Map<string, string>();
  for (const route of routes) {
    const normalized = route.segments.map(segment => parameter(segment) === undefined ? segment.toLowerCase() : "[]").join("/");
    if (patterns.has(normalized)) throw new HtmlKitError(`Route conflict: ${patterns.get(normalized)} and ${route.component} (${route.pattern}).`, route.component);
    patterns.set(normalized, `${route.component} (${route.pattern})`);
  }
  const pageNames = new Map<string, { component: string; pattern: string; identity: string }>();
  const discovered: ApplicationRoute[] = [];
  const layoutDefaults = Object.entries(options.layoutDefaults ?? {}).sort(([a], [b]) => b.length - a.length);
  for (const { prefix: _prefix, ...route } of routes) {
    const { identity, resource } = await resourceOf(route.component);
    const pageName = pageDefinition(resource, route.component).contract.tag;
    const previous = pageNames.get(pageName);
    if (previous !== undefined && previous.identity !== identity) {
      throw new HtmlKitError(`Duplicate page component <${pageName}>: ${previous.component} (${previous.pattern}) and ${route.component} (${route.pattern}).`, route.component);
    }
    pageNames.set(pageName, { component: route.component, pattern: route.pattern, identity });
    const metadata = resource.components.get(pageName)!;
    const directory = layoutDefaults.find(([prefix]) => route.pattern.startsWith(prefix));
    let selected = metadata.layout ?? directory?.[1] ?? options.layout;
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
    discovered.push({ ...route, layouts, pageName, ...(metadata.label === undefined ? {} : { label: metadata.label }),
      ...(metadata.hidden ? { hidden: true } : {}) });
  }
  return { routes: discovered, sources, files };
}
export function matchRoute(routes: readonly ApplicationRoute[], pathname: string, base: string) {
  if (!pathname.startsWith(base)) return undefined;
  let segments: string[];
  try { segments = pathname.slice(base.length).replace(/\/$/, "").split("/").filter(Boolean).map(decodeURIComponent); }
  catch { return undefined; }
  if (segments.some(segment => !validSegment(segment))) return undefined;
  // Literal segments precede parameters; never depend on filesystem order.
  const sorted = [...routes].sort((a, b) => {
    for (let i = 0; i < Math.min(a.segments.length, b.segments.length); i++) {
      const difference = Number(parameter(a.segments[i]!) !== undefined) - Number(parameter(b.segments[i]!) !== undefined);
      if (difference !== 0) return difference;
    }
    return a.pattern.localeCompare(b.pattern);
  });
  for (const route of sorted) {
    if (route.segments.length !== segments.length) continue;
    const params: Record<string, string> = {};
    if (route.segments.every((segment, index) => {
      const name = parameter(segment);
      if (name === undefined) return segment === segments[index];
      params[name] = segments[index]!;
      return true;
    })) return { route, params: Object.freeze(params) };
  }
  return undefined;
}
