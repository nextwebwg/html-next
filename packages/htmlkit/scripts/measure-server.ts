/**
 * Request throughput and latency of a built server under `htmlkit start`: a prerendered page, a
 * server-rendered page, and an endpoint. Build the package first (`pnpm build`); the server runs
 * from dist without Vite. The application builds into `.measure/`, which git ignores, inside this
 * package, so its server entry resolves @nextwebwg/htmlkit/server by the package's own name.
 *
 *   pnpm --filter @nextwebwg/htmlkit measure:server [--seconds 10] [--connections 16]
 */
import { spawn } from "node:child_process";
import { Agent, request } from "node:http";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { buildApplication } from "../src/index.js";

const { values } = parseArgs({ options: { seconds: { type: "string", default: "10" }, connections: { type: "string", default: "16" } } });
const seconds = Number(values.seconds);
const connections = Number(values.connections);
const root = fileURLToPath(new URL("../.measure/server-app/", import.meta.url));
const files: Readonly<Record<string, string>> = {
  "app/layouts/default.html": '<template component="site-shell"><title>Site</title><main><slot name="page"></slot></main></template>',
  "app/pages/index.html": '<template component="page-home"><title>Home</title><h1>Home</h1></template>',
  "app/pages/hello.html": '<template component="page-hello"><meta name="hk:render" content="server"><title>Hello</title><defs><prop name="name" type="string" required>Name</prop></defs><h1>Hello {$name}</h1></template>',
  "app/pages/hello.server.ts": 'export const load = ({ url }) => ({ props: { name: url.searchParams.get("name") ?? "world" } });',
  "app/api/hello.server.ts": 'export const GET = request => Response.json({ hello: new URL(request.url).searchParams.get("name") ?? "world" });',
};
await rm(root, { recursive: true, force: true });
for (const [file, contents] of Object.entries(files)) {
  await mkdir(dirname(join(root, file)), { recursive: true });
  await writeFile(join(root, file), contents);
}
await buildApplication({ root });

const server = spawn(process.execPath, [fileURLToPath(new URL("../dist/cli.js", import.meta.url)), "start", root, "--port", "0"], { stdio: ["ignore", "pipe", "inherit"] });
const origin = await new Promise<string>((done, reject) => {
  let output = "";
  server.stdout.on("data", (chunk: Buffer) => { output += chunk; const match = /HTMLKit start: (http:\/\/[^/]+)/.exec(output); if (match) done(match[1]!); });
  server.once("exit", code => reject(new Error(`htmlkit start exited (${code}): ${output}`)));
});

/** `connections` keep-alive clients, each sending its next request when the last one answers. */
async function load(path: string, duration: number) {
  const agent = new Agent({ keepAlive: true, maxSockets: connections });
  const latencies: number[] = [];
  const end = performance.now() + duration * 1000;
  const once = () => new Promise<void>((done, reject) => {
    const start = performance.now();
    request(origin + path, { agent }, response => {
      if (response.statusCode !== 200) reject(new Error(`${path} answered ${response.statusCode}`));
      response.resume().once("end", () => { latencies.push(performance.now() - start); done(); });
    }).once("error", reject).end();
  });
  const started = performance.now();
  await Promise.all(Array.from({ length: connections }, async () => { while (performance.now() < end) await once(); }));
  const elapsed = (performance.now() - started) / 1000;
  agent.destroy();
  latencies.sort((a, b) => a - b);
  const at = (quantile: number) => latencies[Math.min(latencies.length - 1, Math.floor(quantile * latencies.length))]!.toFixed(2);
  return { requests: latencies.length, perSecond: (latencies.length / elapsed).toFixed(0), p50: at(0.5), p99: at(0.99) };
}

try {
  console.log(`${connections} connections, ${seconds} s each, after a 2 s warm-up`);
  console.log("route\trequests/s\tp50 ms\tp99 ms\trequests");
  for (const [label, path] of [["prerendered page", "/"], ["server-rendered page", "/hello/?name=Ada"], ["endpoint", "/api/hello?name=Ada"]] as const) {
    await load(path, 2);
    const { requests, perSecond, p50, p99 } = await load(path, seconds);
    console.log(`${label}\t${perSecond}\t${p50}\t${p99}\t${requests}`);
  }
} finally { server.kill(); }
