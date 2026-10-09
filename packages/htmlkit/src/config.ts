import { isAbsolute, relative, resolve, sep } from "node:path";
import { normalizePath } from "vite";
import type { ApplicationOptions } from "./types.js";

export class HtmlKitError extends Error {
  constructor(message: string, readonly source?: string) {
    super(source === undefined ? message : `${source}: ${message}`);
    this.name = "HtmlKitError";
  }
}
export function within(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}
export function configure(options: ApplicationOptions) {
  const root = resolve(options.root ?? process.cwd());
  const base = options.base ?? "/";
  if (!/^\/(?:[A-Za-z0-9_-]+\/)*$/.test(base)) throw new HtmlKitError("base must be an absolute path with a trailing slash, for example /docs/.");
  const origin = new URL(options.origin ?? "http://localhost");
  if (!/^https?:$/.test(origin.protocol) || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) {
    throw new HtmlKitError("origin must be an HTTP(S) origin without a path, credentials, query, or fragment.");
  }
  const outDir = resolve(root, options.outDir ?? "dist");
  // A failed build must never erase source, the application, or its dependencies.
  if (within(outDir, root) || ["app", "src", "public", "node_modules", ".git"].some(path => within(resolve(root, path), outDir))) {
    throw new HtmlKitError("Unsafe output directory; choose dist or a separate deployment directory.", outDir);
  }
  return { root, base, origin: origin.origin, outDir };
}

const pluginsApplied = new WeakSet<ApplicationOptions>();
/** Merge each plugin's config() once; options already merged pass through, so nested entry points don't repeat hooks. */
export async function withPlugins(options: ApplicationOptions): Promise<ApplicationOptions> {
  if (pluginsApplied.has(options) || options.plugins === undefined) return options;
  let merged = options;
  for (const plugin of options.plugins) merged = { ...merged, ...await plugin.config?.(merged), plugins: options.plugins };
  merged = { ...merged };
  pluginsApplied.add(merged);
  return merged;
}

/** Vite's side of the import map's @/ entry, for loaders, controllers, and stylesheets. */
export function rootAlias(root: string) {
  return [{ find: /^@\//, replacement: normalizePath(root) + "/" }];
}
