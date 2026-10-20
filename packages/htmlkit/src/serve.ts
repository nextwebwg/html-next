import { createServer as createHTTPServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { createServer, isRunnableDevEnvironment, normalizePath } from "vite";

import { createApplication } from "./application.js";
import { readManifest } from "./build.js";
import { browserPlugin, browserSources, stylesheetSources } from "./browser.js";
import { configure, globalStylesheets, HtmlKitError, rootAlias, runHook, withPlugins, within } from "./config.js";
import { developmentPolicyOptions } from "./csp.js";
import { authoredHead, documentHTML, escapeHTML, type PageAssets } from "./document.js";
import { matchRoute } from "./routes.js";
import { listen, mime, nodeRequest, outputPath, sendResponse } from "./server.js";
import type { Application, ApplicationServer, RenderedPage, ServerOptions } from "./types.js";

function requestPath(request: IncomingMessage): string {
  const original = "originalUrl" in request && typeof request.originalUrl === "string" ? request.originalUrl : request.url;
  return new URL(original ?? "/", "http://localhost").pathname;
}
function methodAllowed(request: IncomingMessage, response: ServerResponse): boolean {
  if (request.method === "GET" || request.method === "HEAD") return true;
  response.writeHead(405, { allow: "GET, HEAD" }); response.end(); return false;
}

export async function previewApplication(input: ServerOptions = {}): Promise<ApplicationServer> {
  const options = await withPlugins(input) as ServerOptions;
  const config = configure(options);
  // Read deployment metadata, never loaders or page source. The same tree works on a static host.
  const { base } = await readManifest(config.outDir);
  const output = await realpath(config.outDir);
  const server = createHTTPServer((request, response) => { void (async () => {
    if (!methodAllowed(request, response)) return;
    const pathname = requestPath(request);
    const found = await outputPath(output, base, pathname);
    if (found === "slash") { response.writeHead(308, { location: pathname + "/" }); response.end(); return; }
    if (found === "invalid") { response.writeHead(400); response.end(); return; }
    // The request server's code is never a file to serve.
    let file = found === undefined || within(join(output, "_htmlkit/server"), found.file) ? undefined : found.file;
    let status = 200;
    if (file === undefined) {
      status = 404;
      file = await realpath(join(output, "404.html"));
      if (!within(output, file)) throw new HtmlKitError("Missing-page output escapes the deployment directory.");
    }
    const body = await readFile(file);
    response.writeHead(status, { "content-type": mime[extname(file)] ?? "application/octet-stream", "content-length": body.length });
    response.end(request.method === "HEAD" ? undefined : body);
  })().catch(error => { response.writeHead(500, { "content-type": "text/plain" }); response.end(String(error)); }); });
  return listen(server, options, base);
}

/**
 * The development pages' Content Security Policy reporter, which runs before the page's own module: it
 * reports each violation in the console and, through Vite's HMR channel, in the terminal, with the
 * csp option line that would allow it.
 */
const policyReporter = `addEventListener("securitypolicyviolation", event => {
  const policy = event.originalPolicy.split(";").map(directive => directive.trim().split(/\\s+/)[0]);
  const directive = [event.effectiveDirective, event.effectiveDirective.replace(/-(?:elem|attr)$/, ""), "default-src"].find(name => policy.includes(name)) ?? event.effectiveDirective;
  const blocked = event.blockedURI;
  const url = URL.parse(blocked);
  const source = blocked === "inline" ? "'unsafe-inline'" : blocked === "eval" ? "'unsafe-eval'" : blocked === "wasm-eval" ? "'wasm-unsafe-eval'"
    : url === null ? blocked : url.origin === "null" ? url.protocol : url.origin;
  const report = { page: location.pathname, blocked, directive, line: "csp: { " + JSON.stringify(directive) + ": [" + JSON.stringify(source) + "] }",
    blocks: event.disposition === "enforce" };
  console.warn("HTMLKit: " + report.page + (report.blocks ? " blocked " : " would block ") + blocked + " under " + directive + ". To allow it, add to htmlkit.config.ts: " + report.line);
  import.meta.hot?.send("htmlkit:csp", report);
});
`;

export async function devApplication(input: ServerOptions = {}): Promise<ApplicationServer> {
  const options = await withPlugins(input) as ServerOptions;
  const config = configure(options);
  // ponytail: any ws: socket rather than Vite's own, whose port is chosen when it listens.
  const csp = developmentPolicyOptions(config.csp, "ws:");
  // Once, before Vite watches, so generated files don't trigger a reload; edits don't rerun it.
  await runHook(options, "buildStart", { command: "dev", root: config.root, base: config.base });
  const sources = new Map<string, string>();
  // Vite refuses to serve a Windows 8.3 short name such as RUNNER~1, so page-wide stylesheets go by their real paths.
  const css = await Promise.all(globalStylesheets(options, config.root).map(file => realpath(file).catch(() => file)));
  let watchReady!: () => void;
  const watching = new Promise<void>(done => { watchReady = done; });
  let application: Application;
  let refreshing: Promise<void> | undefined;
  const vite = await createServer({ root: config.root, configFile: false, appType: "custom", base: config.base, resolve: { alias: rootAlias(config.root) },
    mode: "development", plugins: [browserPlugin(sources), {
      name: "htmlkit-watch-ready", configureServer(server) { server.watcher.once("ready", watchReady); },
      async closeBundle() { await refreshing?.catch(() => {}); await application?.close(); },
    }], optimizeDeps: { noDiscovery: true, include: [] },
    server: { host: options.host ?? "127.0.0.1", port: options.port ?? 3000,
      // Page-wide stylesheets may live outside the root, as a plugin's own stylesheet does.
      fs: { allow: [config.root, await realpath(config.root), await realpath(resolve(import.meta.dirname, "../../..")), ...css.map(file => dirname(file))] } },
    logLevel: "silent" });
  // Browser modules and stylesheets for each served page, as Vite virtual modules.
  const assets = (page: RenderedPage): PageAssets => {
    const graphId = createHash("sha256").update(page.components.map(component => component.definition.source.file).join("\0")).digest("hex").slice(0, 16);
    const id = `virtual:htmlkit/${graphId}`;
    for (const [module, source] of browserSources(page.components, { base: config.base, prefetch: config.prefetch }, id, css)) sources.set(module, source);
    const styles = stylesheetSources(page.components);
    for (const [id, css] of styles) sources.set(id, css);
    // Vite's HTML transformer applies its base to root-relative assets a second time.
    // This document is already composed for its deployment URL; only modules use Vite.
    // Page-wide stylesheets first, so component styles follow them in the cascade.
    return { styles: [...css.map(normalizePath), ...styles.keys()].map(id => config.base + "@fs/" + id),
      modules: [config.base + "@vite/client", ...csp === false ? [] : [config.base + "@id/" + reporter], config.base + "@id/" + id] };
  };
  const reporter = "virtual:htmlkit/csp-report";
  if (csp !== false) {
    sources.set(reporter, policyReporter);
    vite.ws.on("htmlkit:csp", (report: { page: string; blocked: string; directive: string; line: string; blocks: boolean }) => {
      console.warn(`HTMLKit: ${report.page} ${report.blocks ? "blocked" : "would block"} ${report.blocked} under ${report.directive}. To allow it, add to htmlkit.config.ts: ${report.line}`);
    });
  }
  try { application = await createApplication(options, vite, assets, csp); }
  catch (error) { await vite.close(); throw error; }
  // What page plugins read, wherever it lives, joins the watched root.
  vite.watcher.add([...application.watchFiles]);
  let revision = 0;
  let current = 0;
  const change = () => {
    revision += 1;
    // ModuleGraph also owns loader dependencies and transitive controller imports.
    vite.moduleGraph.invalidateAll();
    const environment = vite.environments.ssr;
    if (environment !== undefined && isRunnableDevEnvironment(environment)) environment.runner.clearCache();
    vite.ws.send({ type: "full-reload" });
  };
  vite.watcher.on("add", change).on("unlink", change).on("change", change);
  vite.middlewares.use((request, response, next) => {
    const pathname = requestPath(request);
    if (!pathname.startsWith(config.base) || pathname.slice(config.base.length).startsWith("@")) { next(); return; }
    const payload = pathname.startsWith(config.base + "_htmlkit/pages/");
    void (async () => {
      if (current !== revision) {
        refreshing ??= (async () => {
          while (current !== revision) {
            const wanted = revision;
            const next = await createApplication(options, vite, assets, csp);
            const previous = application;
            application = next;
            vite.watcher.add([...application.watchFiles]);
            current = wanted;
            sources.clear();
            if (csp !== false) sources.set(reporter, policyReporter);
            await previous.close();
          }
        })().finally(() => { refreshing = undefined; });
        await refreshing;
      }
      let file: string | undefined;
      try { file = application.files.get(decodeURIComponent(pathname.slice(config.base.length))); } catch { /* Not a served file. */ }
      // Other files, such as public/ and the application's modules, are Vite's to serve.
      if (file === undefined && !payload && /\.[A-Za-z0-9]+$/.test(pathname) && matchRoute(application.routes, pathname, config.base) === undefined &&
        matchRoute(application.endpoints, pathname, config.base) === undefined) { next(); return; }
      if (file !== undefined) {
        if (!methodAllowed(request, response)) return;
        const body = await readFile(file);
        response.writeHead(200, { "content-type": mime[extname(file)] ?? "application/octet-stream", "content-length": body.length });
        response.end(request.method === "HEAD" ? undefined : body);
        return;
      }
      // Middleware, endpoints, and pages come from the runtime-neutral handler; this adapts Node's request and response.
      await sendResponse(await application.fetch(nodeRequest(request, response)), response);
    })().catch(error => {
      vite.ssrFixStacktrace(error instanceof Error ? error : new Error(String(error)));
      if (response.headersSent) { response.end(); return; }
      response.writeHead(500, { "content-type": "text/html; charset=utf-8" });
      response.end(documentHTML(`<main><h1>Application error</h1><pre>${escapeHTML(String(error))}</pre></main>`, { html: authoredHead + "<title>Application error</title>" }));
    });
  });
  try { await vite.listen(); await watching; }
  catch (error) { await vite.close(); throw error; }
  const address = vite.httpServer?.address();
  if (address === undefined || address === null || typeof address === "string") { await vite.close(); throw new HtmlKitError("Dev server did not obtain a TCP port."); }
  const host = options.host ?? "127.0.0.1";
  let closing: Promise<void> | undefined;
  return { url: `http://${host.includes(":") ? `[${host}]` : host}:${address.port}${config.base}`, close: () => closing ??= vite.close() };
}
