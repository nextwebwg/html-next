import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile, copyFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { Manifest, ManifestChunk } from "vite";

import { createApplication, headScripts, notFoundPage } from "./application.js";
import { browserSources, stylesheetSources } from "./browser.js";
import { bundleBrowser } from "./bundle.js";
import { configure, globalStylesheets, HtmlKitError, runHook, withPlugins, within } from "./config.js";
import { documentHTML, escapeHTML, pagePayload, payloadPath, redirectPage } from "./document.js";
import { checkLinks } from "./links.js";
import { matchRoute, redirectTable } from "./routes.js";
import type { ApplicationOptions, BuildManifest, BuildResult, ManifestRedirect, RedirectStatus } from "./types.js";

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function copyPublic(source: string, output: string): Promise<void> {
  if (!await exists(source)) return;
  if ((await lstat(source)).isSymbolicLink()) throw new HtmlKitError("Public assets must not be symbolic links.", source);
  for (const file of await readdir(source, { withFileTypes: true })) {
    const from = join(source, file.name);
    const to = join(output, file.name);
    if (file.isSymbolicLink()) throw new HtmlKitError("Public assets must not be symbolic links.", from);
    if (file.isDirectory()) { await mkdir(to, { recursive: true }); await copyPublic(from, to); }
    else if (file.isFile()) { await mkdir(dirname(to), { recursive: true }); await copyFile(from, to); }
  }
}

async function canonicalDestination(path: string): Promise<string> {
  try { return await realpath(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return join(await canonicalDestination(dirname(path)), basename(path));
  }
}

/** Read a build's _htmlkit/manifest.json, refusing a format version this HTMLKit doesn't know. */
export async function readManifest(outDir: string): Promise<BuildManifest> {
  const file = join(outDir, "_htmlkit/manifest.json");
  const manifest = JSON.parse(await readFile(file, "utf8")) as BuildManifest;
  if (manifest.version !== 1) throw new HtmlKitError(`Unsupported manifest version ${String(manifest.version)}; this HTMLKit reads version 1.`, file);
  // Builds from before redirects have none.
  return { ...manifest, redirects: manifest.redirects ?? [] };
}

export async function buildApplication(input: ApplicationOptions = {}): Promise<BuildResult> {
  const options = await withPlugins(input);
  const config = configure(options);
  const root = await realpath(config.root);
  const destination = await canonicalDestination(config.outDir);
  if (within(destination, root) || (await Promise.all(["app", "src", "public", "node_modules", ".git"].map(path => canonicalDestination(join(root, path))))).some(path => within(path, destination))) {
    throw new HtmlKitError("Unsafe output directory through a filesystem alias.", config.outDir);
  }
  if (await exists(config.outDir) && !(await lstat(config.outDir)).isDirectory()) throw new HtmlKitError("Output must be a directory.", config.outDir);
  if (await exists(config.outDir) && (await readdir(config.outDir)).length > 0 && !await exists(join(config.outDir, "_htmlkit/manifest.json"))) {
    throw new HtmlKitError("Refusing to replace nonempty output without an HTMLKit build manifest.", config.outDir);
  }
  await mkdir(dirname(config.outDir), { recursive: true });
  // Before any page is read, so generated pages, data, and assets are part of the build.
  await runHook(options, "buildStart", { command: "build", root: config.root, base: config.base });
  const application = await createApplication(options);
  // Sibling staging keeps rename on the same volume. No failed render or bundle replaces dist.
  let stage: string;
  try { stage = await mkdtemp(join(dirname(config.outDir), ".htmlkit-build-")); }
  catch (error) { await application.close(); throw error; }
  const backup = stage + "-previous";
  try {
    const entries = await application.entries();
    if (entries.length === 0) throw new HtmlKitError("No pages found in app/pages or registered routes.", config.root);
    await copyPublic(resolve(config.root, "public"), stage);
    if (await exists(join(stage, "_htmlkit"))) throw new HtmlKitError("Public asset collision: _htmlkit is reserved for generated assets.");
    if (options.robots !== undefined && options.robots !== false && await exists(join(stage, "robots.txt"))) {
      throw new HtmlKitError("Public asset collision: robots.txt is generated from the robots option.");
    }
    const pages = [];
    const sources = new Map<string, string>();
    const redirects: ManifestRedirect[] = [...redirectTable(config.base, options.redirects)].map(([from, to]) => ({ from, to, status: 308 }));
    // The not-found page renders like a page, through its layouts, and becomes 404.html.
    let notFoundIndex = -1;
    for (const pathname of application.notFound === undefined ? entries : [...entries, config.base + "404/"]) {
      const page = await application.render(pathname);
      // A loader's redirect() makes the page a redirect page.
      if (page.location !== undefined) { redirects.push({ from: page.pathname, to: page.location, status: page.status as RedirectStatus }); continue; }
      if (page.status === 404) notFoundIndex = pages.length;
      pages.push(page);
      for (const [id, source] of browserSources(page.components, { base: config.base, prefetch: config.prefetch,
        manifest: config.base + "_htmlkit/manifest.json" }, `virtual:htmlkit/page-${pages.length - 1}`, globalStylesheets(options, config.root))) sources.set(id, source);
      for (const [id, css] of stylesheetSources(page.components)) sources.set(id, css);
    }
    const browserInputs = await bundleBrowser({ root: config.root, base: config.base, outDir: stage, sources });
    for (const [path, file] of application.files) {
      const target = join(stage, path);
      if (await exists(target)) throw new HtmlKitError(`Generated file collision at ${path}.`, file);
      await mkdir(dirname(target), { recursive: true });
      await copyFile(file, target);
    }
    const manifest = JSON.parse(await readFile(join(stage, "_htmlkit/vite-manifest.json"), "utf8")) as Manifest;
    const bundles = new Map(Object.values(manifest).filter(chunk => chunk.isEntry).map(chunk => [chunk.name, chunk]));
    const delivery = [];
    // sitemap.xml lists each page at its own URL: no alias, redirect, not-found page, or page marked noindex.
    const indexed: string[] = [];
    let notFoundHTML = notFoundPage(await headScripts(options, config.root)).html;
    for (let i = 0; i < pages.length; i++) {
      const page = pages[i]!;
      const path = join(stage, decodeURIComponent(page.pathname.slice(config.base.length)), "index.html");
      if (i !== notFoundIndex && await exists(path)) throw new HtmlKitError(`Public asset collision with route ${page.pathname}.`, path);
      const entry = bundles.get(`page-${i}`);
      if (entry === undefined) throw new HtmlKitError(`Missing browser bundle for ${page.pathname}.`);
      const route = i === notFoundIndex ? application.notFound! : matchRoute(application.routes, page.pathname, config.base)!.route;
      // Vite's manifest includes CSS from the entry and its shared static imports.
      const styles = new Set<string>();
      const seen = new Set<ManifestChunk>();
      const collect = (chunk: ManifestChunk): void => {
        if (seen.has(chunk)) return;
        seen.add(chunk);
        for (const css of chunk.css ?? []) styles.add(config.base + css);
        for (const id of chunk.imports ?? []) { const imported = manifest[id]; if (imported !== undefined) collect(imported); }
      };
      collect(entry);
      // Shared chunks, which links on screen may prefetch; the entry holds the page's own content.
      const chunks = [...seen].filter(chunk => chunk !== entry).map(chunk => config.base + chunk.file);
      const assets = { styles: [...styles], modules: [config.base + entry.file] };
      // Served at any missing path, so it has no route, manifest entry, or payload; its asset URLs are absolute.
      if (i === notFoundIndex) { notFoundHTML = documentHTML(page.body, page.head, assets); continue; }
      delivery.push({ pathname: page.pathname, pageName: route.pageName, browserModule: config.base + entry.file, chunks });
      if (route.canonical === undefined && !page.head.elements?.some(element => element.tag === "meta" && element.attributes.name?.toLowerCase() === "robots" &&
        /\b(?:noindex|none)\b/i.test(element.attributes.content ?? ""))) indexed.push(page.pathname);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, documentHTML(page.body, page.head, assets));
      const payload = pagePayload(page, assets);
      if (payload !== undefined) {
        const file = join(stage, decodeURIComponent(payloadPath(config.base, page.pathname).slice(config.base.length)));
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, JSON.stringify(payload));
      }
    }
    await rm(join(stage, "_htmlkit/vite-manifest.json"));
    if (await exists(join(stage, "404.html"))) throw new HtmlKitError("Public asset collision: 404.html is generated.");
    await writeFile(join(stage, "404.html"), notFoundHTML);
    // Static hosts have no server redirects, so each old URL gets a page that sends readers on.
    for (const { from, to } of redirects) {
      const path = join(stage, decodeURIComponent(from.slice(config.base.length)), "index.html");
      if (await exists(path)) throw new HtmlKitError(`Redirect collision at ${from}: a public asset or page is already there.`, path);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, redirectPage(to).html);
    }
    // A public sitemap.xml is the site's own and stays as it is.
    if (options.origin !== undefined && !await exists(join(stage, "sitemap.xml"))) {
      await writeFile(join(stage, "sitemap.xml"), '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
        indexed.map(pathname => `<url><loc>${escapeHTML(config.origin + pathname)}</loc></url>\n`).join("") + "</urlset>\n");
    }
    if (options.robots !== undefined && options.robots !== false) {
      const rules = options.robots === true ? "User-agent: *\nAllow: /\n" : options.robots.replace(/\n?$/, "\n");
      const sitemap = options.origin === undefined || /^sitemap:/im.test(rules) ? "" : `Sitemap: ${config.origin}${config.base}sitemap.xml\n`;
      await writeFile(join(stage, "robots.txt"), rules + sitemap);
    }
    const routes = delivery.map(page => page.pathname);
    const published: BuildManifest = { version: 1, base: config.base, routes, pages: delivery, redirects };
    await writeFile(join(stage, "_htmlkit/manifest.json"), JSON.stringify(published, null, 2) + "\n");
    await runHook(options, "buildEnd", { root: config.root, base: config.base, outDir: stage, routes: application.routes, pages: routes,
      async writeFile(path, contents) {
        const target = resolve(stage, path);
        if (isAbsolute(path) || target === stage || !within(stage, target)) throw new HtmlKitError(`Output path ${path} must be relative and inside the output.`);
        if (within(join(stage, "_htmlkit"), target)) throw new HtmlKitError(`Output path ${path} is in _htmlkit, which is reserved for generated assets.`);
        await mkdir(dirname(target), { recursive: true });
        // wx refuses an existing file, so a plugin never replaces a page, an asset, or another plugin's file.
        try { await writeFile(target, contents, { flag: "wx" }); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new HtmlKitError(`Output collision at ${path}: the build already wrote it.`);
          throw error;
        }
      } });
    // After buildEnd, so the files plugins add are link targets too.
    await checkLinks(stage, config.origin, config.base, [...routes, ...redirects.map(redirect => redirect.from), config.base + "404.html"], options.linkCheck);
    const previous = await exists(config.outDir);
    if (previous) await rename(config.outDir, backup);
    try { await rename(stage, config.outDir); }
    catch (error) { if (previous) await rename(backup, config.outDir); throw error; }
    if (previous) await rm(backup, { recursive: true, force: true });
    return { outDir: config.outDir, routes, browserInputs };
  } finally {
    try { await application.close(); }
    finally { await rm(stage, { recursive: true, force: true }); }
  }
}
