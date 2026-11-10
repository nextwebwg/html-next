import { createServer } from "node:http";
import { readFile, readdir, stat } from "node:fs/promises";
import { extname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseComponent } from "@nextwebwg/html-next";
import { closeRenderWorkers, renderComponents } from "@nextwebwg/html-next/server";

const sourceURL = new URL("./counter.html", import.meta.url);
const definition = parseComponent(await readFile(sourceURL, "utf8"), sourceURL.href);
const assets = fileURLToPath(new URL("./wwwroot/assets/", import.meta.url));
const files = new Map();
for (const name of await readdir(assets, { recursive: true })) {
  const file = join(assets, name);
  if (!(await stat(file)).isFile()) continue;
  const type = extname(name) === ".js" ? "text/javascript" : extname(name) === ".css" ? "text/css" : "application/octet-stream";
  files.set(`/assets/${name.split(sep).join("/")}`, { type, body: await readFile(file) });
}

const port = Number(process.env.PORT ?? 5001);
const server = createServer((request, response) => {
  const url = new URL(request.url, `http://localhost:${port}`);
  const asset = files.get(url.pathname);
  if (asset) { response.writeHead(200, { "content-type": asset.type }).end(asset.body); return; }
  if (url.pathname !== "/") { response.writeHead(404).end(); return; }
  const start = Number(url.searchParams.get("start") ?? 5);
  renderComponents("<x-counter></x-counter>", {
    definitions: [definition], props: { "x-counter": { start } }, url: url.href,
  }).then(({ html }) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html>
      <html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>HTML Next with Node</title></head>
      <body><main><h1>Node renders. JavaScript keeps it interactive.</h1>${html}</main><script type="module" src="/assets/app.js"></script></body></html>`);
  }).catch(error => { console.error(error); response.writeHead(500).end("Rendering failed"); });
});
server.listen(port, "127.0.0.1", () => console.log(`http://localhost:${port}/?start=12`));
process.once("SIGTERM", () => { server.close(); void closeRenderWorkers(); });
