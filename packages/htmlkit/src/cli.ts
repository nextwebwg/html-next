#!/usr/bin/env node
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { buildApplication } from "./build.js";
import { HtmlKitError, loadConfig } from "./config.js";
import { devApplication, previewApplication } from "./serve.js";
import type { ServerOptions } from "./types.js";

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
  const options: ServerOptions = { ...await loadConfig(root), root,
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
