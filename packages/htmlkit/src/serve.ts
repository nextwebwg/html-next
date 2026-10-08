import { createServer as createHTTPServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { createServer, isRunnableDevEnvironment } from "vite";

import { createApplication } from "./application.js";
import { browserPlugin, browserSources, stylesheetSources } from "./browser.js";
import { configure, HtmlKitError, within } from "./config.js";
import { documentHTML, escapeHTML } from "./document.js";
import { matchRoute } from "./routes.js";
import type { Application, ApplicationServer, ServerOptions } from "./types.js";

const mime: Readonly<Record<string, string>> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
  ".webp": "image/webp", ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8" };

async function listen(server: Server, options: ServerOptions, base: string): Promise<ApplicationServer> {
  const host = options.host ?? "127.0.0.1";
  await new Promise<void>((done, reject) => { server.once("error", reject); server.listen(options.port ?? 3000, host, done); });
  const address = server.address();
  if (address === null || typeof address === "string") throw new HtmlKitError("Server did not obtain a TCP port.");
  return { url: `http://${host.includes(":") ? `[${host}]` : host}:${address.port}${base}`,
    close: () => new Promise<void>((done, reject) => { server.close(error => error ? reject(error) : done()); server.closeIdleConnections(); }) };
}

function requestPath(request: IncomingMessage): string {
  const original = "originalUrl" in request && typeof request.originalUrl === "string" ? request.originalUrl : request.url;
  return new URL(original ?? "/", "http://localhost").pathname;
}
function redirect(response: ServerResponse, pathname: string): void {
  response.writeHead(308, { location: pathname + "/" }); response.end();
}
function methodAllowed(request: IncomingMessage, response: ServerResponse): boolean {
  if (request.method === "GET" || request.method === "HEAD") return true;
  response.writeHead(405, { allow: "GET, HEAD" }); response.end(); return false;
}

export async function previewApplication(options: ServerOptions = {}): Promise<ApplicationServer> {
  const config = configure(options);
  // Read deployment metadata, never loaders or page source. The same tree works on a static host.
  const manifest = JSON.parse(await readFile(join(config.outDir, "_htmlkit/manifest.json"), "utf8")) as { base: string };
  const base = manifest.base;
  const output = await realpath(config.outDir);
  const server = createHTTPServer((request, response) => { void (async () => {
    if (!methodAllowed(request, response)) return;
    const pathname = requestPath(request);
    if (pathname === base.slice(0, -1) && base !== "/") { redirect(response, pathname); return; }
    let file: string | undefined;
    if (pathname.startsWith(base)) {
      let decoded: string;
      try { decoded = decodeURIComponent(pathname.slice(base.length)); } catch { response.writeHead(400); response.end(); return; }
      const candidate = resolve(output, decoded || ".");
      if (!within(output, candidate)) { response.writeHead(404); response.end(); return; }
      try {
        const canonical = await realpath(candidate);
        if (within(output, canonical)) {
          const info = await stat(canonical);
          if (info.isDirectory()) {
            if (!pathname.endsWith("/")) { redirect(response, pathname); return; }
            file = join(canonical, "index.html");
          } else file = canonical;
        }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    let body: Buffer;
    let status = 200;
    if (file !== undefined) {
      try { file = await realpath(file); if (!within(output, file)) file = undefined; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; file = undefined; }
    }
    if (file === undefined) {
      status = 404;
      file = await realpath(join(output, "404.html"));
      if (!within(output, file)) throw new HtmlKitError("Missing-page output escapes the deployment directory.");
    }
    body = await readFile(file);
    response.writeHead(status, { "content-type": mime[extname(file ?? "404.html")] ?? "application/octet-stream", "content-length": body.length });
    response.end(request.method === "HEAD" ? undefined : body);
  })().catch(error => { response.writeHead(500, { "content-type": "text/plain" }); response.end(String(error)); }); });
  return listen(server, options, base);
}

export async function devApplication(options: ServerOptions = {}): Promise<ApplicationServer> {
  const config = configure(options);
  const sources = new Map<string, string>();
  let watchReady!: () => void;
  const watching = new Promise<void>(done => { watchReady = done; });
  const vite = await createServer({ root: config.root, configFile: false, appType: "custom", base: config.base,
    mode: "development", plugins: [browserPlugin(sources), {
      name: "htmlkit-watch-ready", configureServer(server) { server.watcher.once("ready", watchReady); },
    }], optimizeDeps: { noDiscovery: true, include: [] },
    server: { host: options.host ?? "127.0.0.1", port: options.port ?? 3000,
      fs: { allow: [config.root, await realpath(config.root), await realpath(resolve(import.meta.dirname, "../../.."))] } },
    logLevel: "silent" });
  let application: Application;
  try { application = await createApplication(options, vite); }
  catch (error) { await vite.close(); throw error; }
  let dirty = false;
  const change = () => {
    dirty = true;
    // ModuleGraph also owns loader dependencies and transitive controller imports.
    vite.moduleGraph.invalidateAll();
    const environment = vite.environments.ssr;
    if (environment !== undefined && isRunnableDevEnvironment(environment)) environment.runner.clearCache();
    vite.ws.send({ type: "full-reload" });
  };
  vite.watcher.on("add", change).on("unlink", change).on("change", change);
  vite.middlewares.use((request, response, next) => {
    const pathname = requestPath(request);
    if (!pathname.startsWith(config.base) || pathname.slice(config.base.length).startsWith("@") ||
      (/\.[A-Za-z0-9]+$/.test(pathname) && matchRoute(application.routes, pathname, config.base) === undefined)) { next(); return; }
    void (async () => {
      if (!methodAllowed(request, response)) return;
      if (dirty) { application = await createApplication(options, vite); dirty = false; sources.clear(); }
      const page = await application.render(pathname);
      if (page.status === 200 && !pathname.endsWith("/")) { redirect(response, pathname); return; }
      const graphId = createHash("sha256").update(page.components.map(component => component.definition.source.file).join("\0")).digest("hex").slice(0, 16);
      const id = `virtual:htmlkit/${graphId}`;
      for (const [module, source] of browserSources(page.components, config.base, id)) sources.set(module, source);
      const styles = stylesheetSources(page.components);
      for (const [id, css] of styles) sources.set(id, css);
      const assets = [...styles.keys()].map(id => `<link rel="stylesheet" href="${escapeHTML(config.base + "@fs/" + id)}">`).join("") +
        `<script type="module" src="${escapeHTML(config.base + "@vite/client")}"></script>` +
        `<script type="module" src="${escapeHTML(config.base + "@id/" + id)}"></script>`;
      // Vite's HTML transformer applies its base to root-relative assets a second time.
      // This document is already composed for its deployment URL; only modules use Vite.
      const html = documentHTML(page.body, page.head, assets);
      response.writeHead(page.status, { "content-type": "text/html; charset=utf-8" });
      response.end(request.method === "HEAD" ? undefined : html);
    })().catch(error => {
      vite.ssrFixStacktrace(error instanceof Error ? error : new Error(String(error)));
      response.writeHead(500, { "content-type": "text/html; charset=utf-8" });
      response.end(documentHTML(`<main><h1>Application error</h1><pre>${escapeHTML(String(error))}</pre></main>`, { title: "Application error" }));
    });
  });
  try { await vite.listen(); await watching; }
  catch (error) { await vite.close(); throw error; }
  const address = vite.httpServer?.address();
  if (address === undefined || address === null || typeof address === "string") { await vite.close(); throw new HtmlKitError("Dev server did not obtain a TCP port."); }
  const host = options.host ?? "127.0.0.1";
  return { url: `http://${host.includes(":") ? `[${host}]` : host}:${address.port}${config.base}`, close: () => vite.close() };
}
