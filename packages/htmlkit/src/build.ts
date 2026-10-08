import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile, copyFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { Manifest, ManifestChunk } from "vite";

import { createApplication } from "./application.js";
import { browserSources, stylesheetSources } from "./browser.js";
import { bundleBrowser } from "./bundle.js";
import { configure, HtmlKitError, within } from "./config.js";
import { documentHTML, escapeHTML } from "./document.js";
import { matchRoute } from "./routes.js";
import type { ApplicationOptions, BuildResult } from "./types.js";

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

export async function buildApplication(options: ApplicationOptions = {}): Promise<BuildResult> {
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
  const application = await createApplication(options);
  // Sibling staging keeps rename on the same volume. No failed render or bundle replaces dist.
  let stage: string;
  try { stage = await mkdtemp(join(dirname(config.outDir), ".htmlkit-build-")); }
  catch (error) { await application.close(); throw error; }
  const backup = stage + "-previous";
  try {
    const routes = await application.entries();
    if (routes.length === 0) throw new HtmlKitError("No pages found in app/pages or registered routes.", config.root);
    await copyPublic(resolve(config.root, "public"), stage);
    if (await exists(join(stage, "_htmlkit"))) throw new HtmlKitError("Public asset collision: _htmlkit is reserved for generated assets.");
    const pages = [];
    const sources = new Map<string, string>();
    for (const pathname of routes) {
      const page = await application.render(pathname);
      pages.push(page);
      for (const [id, source] of browserSources(page.components, config.base, `virtual:htmlkit/page-${pages.length - 1}`)) sources.set(id, source);
      for (const [id, css] of stylesheetSources(page.components)) sources.set(id, css);
    }
    const browserInputs = await bundleBrowser({ root: config.root, base: config.base, outDir: stage, sources });
    const manifest = JSON.parse(await readFile(join(stage, "_htmlkit/vite-manifest.json"), "utf8")) as Manifest;
    const bundles = new Map(Object.values(manifest).filter(chunk => chunk.isEntry).map(chunk => [chunk.name, chunk]));
    const delivery = [];
    for (let i = 0; i < pages.length; i++) {
      const page = pages[i]!;
      const path = join(stage, decodeURIComponent(page.pathname.slice(config.base.length)), "index.html");
      if (await exists(path)) throw new HtmlKitError(`Public asset collision with route ${page.pathname}.`, path);
      const entry = bundles.get(`page-${i}`);
      if (entry === undefined) throw new HtmlKitError(`Missing browser bundle for ${page.pathname}.`);
      const route = matchRoute(application.routes, page.pathname, config.base)!.route;
      delivery.push({ pathname: page.pathname, pageName: route.pageName, browserModule: config.base + entry.file });
      // Vite's manifest includes CSS from the entry and its shared static imports.
      const styles = new Set<string>();
      const seen = new Set<ManifestChunk>();
      const collect = (chunk: ManifestChunk): void => {
        if (seen.has(chunk)) return;
        seen.add(chunk);
        for (const css of chunk.css ?? []) styles.add(css);
        for (const id of chunk.imports ?? []) { const imported = manifest[id]; if (imported !== undefined) collect(imported); }
      };
      collect(entry);
      const assets = [...styles].map(css => `<link rel="stylesheet" href="${escapeHTML(config.base + css)}">`).join("") +
        `<script type="module" src="${escapeHTML(config.base + entry.file)}"></script>`;
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, documentHTML(page.body, page.head, assets));
    }
    await rm(join(stage, "_htmlkit/vite-manifest.json"));
    if (await exists(join(stage, "404.html"))) throw new HtmlKitError("Public asset collision: 404.html is generated.");
    await writeFile(join(stage, "404.html"), documentHTML('<main><h1>Page not found</h1></main>', { title: "Page not found" }));
    await writeFile(join(stage, "_htmlkit/manifest.json"), JSON.stringify({ version: 1, base: config.base, routes, pages: delivery }, null, 2) + "\n");
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
