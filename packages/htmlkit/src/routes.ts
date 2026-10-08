import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { HtmlKitError } from "./config.js";
import { applicationResource, pageDefinition } from "./resource.js";
import type { ApplicationOptions, ApplicationRoute, RouteInput, RouteLayer } from "./types.js";

export function parameter(segment: string): string | undefined { return /^\[([A-Za-z][A-Za-z0-9_]*)\]$/.exec(segment)?.[1]; }
export function validSegment(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value !== "." && value !== ".." && !value.includes("/") && !/[\\\0?#]/.test(value);
}
export async function discoverRoutes(root = process.cwd(), options: Pick<ApplicationOptions, "routes" | "fileRoutes" | "layout" | "layoutDefaults" | "routeOrdering"> = {},
  files?: ReadonlyMap<string, string>): Promise<readonly ApplicationRoute[]> {
  const routes: Omit<ApplicationRoute, "pageName">[] = [];
  const add = (input: RouteInput, order?: readonly (string | null)[]): void => {
    if (!/^\/(?:[^/]+\/)*$/.test(input.pattern)) throw new HtmlKitError("Route patterns require leading and trailing slashes.", input.component);
    const segments = input.pattern.slice(1, -1).split("/").filter(Boolean);
    if (segments[0] === "_htmlkit") throw new HtmlKitError("_htmlkit is reserved for generated assets.", input.component);
    if (segments.some(segment => parameter(segment) === undefined && !/^[A-Za-z0-9_-]+$/.test(segment))) {
      throw new HtmlKitError("Route segments must be URL slugs or [named] parameters.", input.component);
    }
    if (order !== undefined && (order.length !== segments.length || order.some(rank => rank !== null && !/^\d+$/.test(rank)))) {
      throw new HtmlKitError("Route order needs one numeric string or null per segment.", input.component);
    }
    const params = segments.flatMap(segment => parameter(segment) ?? []);
    if (new Set(params).size !== params.length) throw new HtmlKitError("Route parameter names must be unique.", input.component);
    const absolute = (layer: RouteLayer): RouteLayer => ({ component: resolve(root, layer.component),
      ...(layer.server === undefined ? {} : { server: typeof layer.server === "string" ? resolve(root, layer.server) : layer.server }) });
    routes.push({ ...absolute(input), pattern: input.pattern, segments, params, layouts: (input.layouts ?? []).map(absolute), ...(order === undefined ? {} : { order }) });
  };
  const ordered = (name: string, source: string) => {
    const prefix = options.routeOrdering ? /^(\d+)-(.*)$/.exec(name) : null;
    if (prefix?.[2] === "") throw new HtmlKitError("Ordering prefix leaves an empty route segment.", source);
    return { slug: prefix?.[2] ?? name, rank: prefix?.[1] ?? null };
  };
  const visit = async (directory: string, segments: string[], order: (string | null)[]): Promise<void> => {
    const files = await readdir(directory, { withFileTypes: true });
    const names = new Set(files.filter(file => file.isFile()).map(file => file.name));
    const layer = (name: string): RouteLayer => {
      const servers = ["ts", "js"].filter(ext => names.has(`${name}.server.${ext}`));
      if (servers.length > 1) throw new HtmlKitError(`Choose one ${name}.server.ts or .js loader.`, directory);
      return { component: join(directory, `${name}.html`), ...(servers[0] === undefined ? {} : { server: join(directory, `${name}.server.${servers[0]}`) }) };
    };
    for (const name of [...names].sort()) {
      if (!name.endsWith(".html") || name.startsWith("_") || name.startsWith(".")) continue;
      const stem = name.slice(0, -5);
      const { slug, rank } = ordered(stem, join(directory, name));
      const parts = slug === "index" ? segments : [...segments, slug];
      add({ ...layer(stem), pattern: `/${parts.length === 0 ? "" : parts.join("/") + "/"}` }, slug === "index" ? order : [...order, rank]);
    }
    for (const file of files.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!file.isDirectory() || file.name.startsWith(".") || file.name.startsWith("_")) continue;
      const { slug, rank } = ordered(file.name, join(directory, file.name));
      if (parameter(slug) === undefined && !/^[A-Za-z0-9_-]+$/.test(slug)) {
        throw new HtmlKitError("Route directories must be URL slugs or [named] parameters.", join(directory, file.name));
      }
      await visit(join(directory, file.name), [...segments, slug], [...order, rank]);
    }
  };
  if (options.fileRoutes !== false) {
    const pages = resolve(root, "app/pages");
    let present = true;
    try { await stat(pages); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; present = false; }
    if (present) await visit(pages, [], []);
  }
  for (const route of options.routes ?? []) add(route, route.order);
  for (const prefix of Object.keys(options.layoutDefaults ?? {})) {
    if (!/^\/(?:[^/]+\/)*$/.test(prefix)) throw new HtmlKitError("Layout defaults require route-directory prefixes with leading and trailing slashes.", prefix);
  }
  const patterns = new Map<string, string>();
  for (const route of routes) {
    const normalized = route.segments.map(segment => parameter(segment) === undefined ? segment.toLowerCase() : "[]").join("/");
    if (patterns.has(normalized)) throw new HtmlKitError(`Route conflict: ${patterns.get(normalized)} and ${route.component} (${route.pattern}).`, route.component);
    patterns.set(normalized, `${route.component} (${route.pattern})`);
  }
  const pageFiles = new Map<string, ReturnType<typeof applicationResource>>();
  const pageNames = new Map<string, { component: string; pattern: string; identity: string }>();
  const discovered: ApplicationRoute[] = [];
  const layoutDefaults = Object.entries(options.layoutDefaults ?? {}).sort(([a], [b]) => b.length - a.length);
  for (const route of routes) {
    // Generated sources have no file, so their path is their identity.
    const supplied = files?.get(route.component);
    const identity = supplied === undefined ? await realpath(route.component) : route.component;
    let resource = pageFiles.get(identity);
    if (resource === undefined) {
      // Read declarations only. Route discovery never executes loaders or controllers.
      resource = applicationResource(supplied ?? await readFile(identity, "utf8"), pathToFileURL(identity).href);
      pageFiles.set(identity, resource);
    }
    const pageName = pageDefinition(resource, route.component).contract.tag;
    const previous = pageNames.get(pageName);
    if (previous !== undefined && previous.identity !== identity) {
      throw new HtmlKitError(`Duplicate page component <${pageName}>: ${previous.component} (${previous.pattern}) and ${route.component} (${route.pattern}).`, route.component);
    }
    pageNames.set(pageName, { component: route.component, pattern: route.pattern, identity });
    const override = resource.components.get(pageName)!.layout;
    const directory = layoutDefaults.find(([prefix]) => route.pattern.startsWith(prefix));
    let selected = override ?? directory?.[1] ?? options.layout;
    if (selected === undefined && route.layouts.length === 0) {
      try { await stat(resolve(root, "app/layouts/default.html")); selected = "default"; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    let layouts = route.layouts;
    if (selected === false || selected === "none") layouts = [];
    else if (selected !== undefined) {
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
    discovered.push({ ...route, layouts, pageName });
  }
  return discovered;
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
