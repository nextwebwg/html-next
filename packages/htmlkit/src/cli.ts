#!/usr/bin/env node
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { createServer } from "vite";
import { buildApplication } from "./build.js";
import { HtmlKitError } from "./config.js";
import { devApplication, previewApplication } from "./serve.js";
import type { ApplicationOptions, ServerOptions } from "./types.js";

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    base: { type: "string" }, origin: { type: "string" }, "out-dir": { type: "string" },
    port: { type: "string" }, host: { type: "string" }, help: { type: "boolean", short: "h" },
  } });
  if (values.help || positionals.length === 0) {
    console.log("Usage: htmlkit <dev|build|preview> [root] [--base /docs/] [--origin https://example.com] [--out-dir dist] [--port 3000] [--host 127.0.0.1]");
    return;
  }
  const command = positionals[0];
  if (!["dev", "build", "preview"].includes(command!) || positionals.length > 2) throw new HtmlKitError("Choose dev, build, or preview and an optional application root.");
  const root = resolve(positionals[1] ?? process.cwd());
  let configured: ApplicationOptions = {};
  const files = ["ts", "js"].map(ext => resolve(root, `htmlkit.config.${ext}`)).filter(existsSync);
  if (files.length > 1) throw new HtmlKitError("Choose one htmlkit.config.ts or .js.", root);
  if (files[0] !== undefined) {
    const loader = await createServer({ root, configFile: false, appType: "custom", logLevel: "silent",
      server: { middlewareMode: true, watch: null, hmr: false }, optimizeDeps: { noDiscovery: true, include: [] } });
    try { configured = (await loader.ssrLoadModule(files[0])).default as ApplicationOptions; }
    finally { await loader.close(); }
    if (configured === null || typeof configured !== "object") throw new HtmlKitError("Configuration must export a default ApplicationOptions object.", files[0]);
  }
  const options: ServerOptions = { ...configured, root,
    ...(values.base === undefined ? {} : { base: values.base }),
    ...(values.origin === undefined ? {} : { origin: values.origin }),
    ...(values["out-dir"] === undefined ? {} : { outDir: values["out-dir"] }),
    ...(values.host === undefined ? {} : { host: values.host }),
    ...(values.port === undefined ? {} : { port: Number(values.port) }) };
  if (options.port !== undefined && (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535)) throw new HtmlKitError("port must be an integer from 0 to 65535.");
  if (command === "build") {
    const result = await buildApplication(options);
    console.log(`Generated ${result.routes.length} pages in ${result.outDir}`);
    return;
  }
  const server = await (command === "dev" ? devApplication(options) : previewApplication(options));
  console.log(`HTMLKit ${command}: ${server.url}`);
  const stop = () => { void server.close().then(() => { process.exitCode = 0; }).catch(error => { console.error(String(error)); process.exitCode = 1; }); };
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
}
void main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
