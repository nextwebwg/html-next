// A small dev server so the example runs against a real JSON endpoint: it serves this directory
// and answers the two declared reads, including the catalog's reactive query parameters.
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const port = Number(process.env.PORT ?? 8799);
const types = {
  ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
  ".json": "application/json", ".css": "text/css",
};

const json = (response, value) => {
  const body = JSON.stringify(value);
  response.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  response.end(body);
};

const load = async (name) => JSON.parse(await readFile(join(root, "api", name), "utf8"));

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://localhost:${port}`);

  if (url.pathname === "/api/pantry") return json(response, await load("pantry.json"));

  // The catalog read receives `q` and `limit` as query parameters and answers with JSON.
  if (url.pathname === "/api/catalog") {
    const needle = (url.searchParams.get("q") ?? "").trim().toLowerCase();
    const limit = Number(url.searchParams.get("limit") ?? 5);
    const catalog = await load("catalog.json");
    const hits = needle === "" ? [] : catalog.filter((entry) => entry.label.toLowerCase().includes(needle));
    return json(response, hits.slice(0, Number.isFinite(limit) ? limit : 5));
  }

  const path = join(root, normalize(url.pathname === "/" ? "/index.html" : url.pathname));
  if (!path.startsWith(root)) {
    response.writeHead(403).end("Forbidden");
    return;
  }
  try {
    await stat(path);
  } catch {
    response.writeHead(404).end("Not found");
    return;
  }
  response.writeHead(200, { "content-type": types[extname(path)] ?? "application/octet-stream" });
  createReadStream(path).pipe(response);
});

server.listen(port, () => process.stdout.write(`Pantry example on http://localhost:${port}/\n`));
