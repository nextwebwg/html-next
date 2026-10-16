#!/usr/bin/env node
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { HtmlKitError, loadConfig } from "./config.js";
import type { ServerOptions } from "./types.js";

const usage = `Usage: htmlkit <command> [root] [options]

Commands:
  dev       Serve the application with live reload
  build     Prerender pages and write the request server to the output
  preview   Serve the build's files as a static host does
  start     Serve the build: prerendered pages, assets, and server routes, endpoints, and middleware

Options:
  --base /docs/                  URL path prefix (dev, build)
  --origin https://example.com   Origin for prerendered absolute URLs (dev, build)
  --out-dir dist                 Build output (build, preview, start)
  --port 3000                    Port; start also reads PORT
  --host 127.0.0.1               Host; start also reads HOST
  --render-workers 4             Workers that render pages; the CPU count, up to 8, by default
  -h, --help                     Show this help`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    base: { type: "string" }, origin: { type: "string" }, "out-dir": { type: "string" },
    port: { type: "string" }, host: { type: "string" }, "render-workers": { type: "string" }, help: { type: "boolean", short: "h" },
  } });
  if (values.help || positionals.length === 0) { console.log(usage); return; }
  const command = positionals[0];
  if (!["dev", "build", "preview", "start"].includes(command!) || positionals.length > 2) throw new HtmlKitError("Choose dev, build, preview, or start and an optional application root.");
  const root = resolve(positionals[1] ?? process.cwd());
  // start runs the build alone: it reads no config file, which Vite would load.
  const port = values.port ?? (command === "start" ? process.env.PORT : undefined);
  const host = values.host ?? (command === "start" ? process.env.HOST : undefined);
  const options: ServerOptions = { ...command === "start" ? {} : await loadConfig(root), root,
    ...(values.base === undefined ? {} : { base: values.base }),
    ...(values.origin === undefined ? {} : { origin: values.origin }),
    ...(values["out-dir"] === undefined ? {} : { outDir: values["out-dir"] }),
    ...(host === undefined ? {} : { host }),
    ...(port === undefined ? {} : { port: Number(port) }) };
  if (options.port !== undefined && (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535)) throw new HtmlKitError("port must be an integer from 0 to 65535.");
  if (values["render-workers"] !== undefined) {
    const count = Number(values["render-workers"]);
    if (!Number.isInteger(count) || count < 1) throw new HtmlKitError("render-workers must be a whole number of at least 1.");
    (await import("@nextwebwg/html-next/server")).setRenderWorkers(count);
  }
  if (command === "build") {
    const { buildApplication } = await import("./build.js");
    const result = await buildApplication(options);
    console.log(`Generated ${result.routes.length} pages in ${result.outDir}`);
    return;
  }
  // Each command loads only its own modules, so start never loads Vite.
  const server = command === "start"
    ? await (await import("./server.js")).startApplication({ outDir: resolve(root, options.outDir ?? "dist"),
      ...(options.host === undefined ? {} : { host: options.host }), ...(options.port === undefined ? {} : { port: options.port }) })
    : await (await import("./serve.js"))[command === "dev" ? "devApplication" : "previewApplication"](options);
  console.log(`HTMLKit ${command}: ${server.url}`);
  const stop = () => { void server.close().then(() => { process.exitCode = 0; }).catch(error => { console.error(String(error)); process.exitCode = 1; }); };
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
}
void main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
