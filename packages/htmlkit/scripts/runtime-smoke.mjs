// Serves pages through application.fetch on the current runtime (Node, Deno, or Bun): the development
// application, and a build's server entry, which Node builds. Run it on Node first, then Deno and Bun,
// in a project with the packed packages installed, as CI does: inside this workspace, Bun applies
// tsconfig paths that point @nextwebwg/html-next at its TypeScript source.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { buildApplication, createApplication } from "@nextwebwg/htmlkit";

const runtime = globalThis.Deno ? "Deno" : globalThis.Bun ? "Bun" : "Node";
const page = '<template component="page-smoke"><defs><prop name="count" type="number" default="21">Count</prop></defs><p>{$count * 2}</p></template>';
const root = await mkdtemp(join(tmpdir(), "htmlkit-runtime-"));
await writeFile(join(root, "package.json"), '{"type":"module"}');
await mkdir(join(root, "app/pages"), { recursive: true });
await writeFile(join(root, "app/pages/index.html"), page);
const application = await createApplication({ root });
try {
  const response = await application.fetch(new Request("http://localhost/"));
  const html = await response.text();
  if (response.status !== 200 || !/>42<\/p>/.test(html)) throw new Error(`${runtime} rendered ${response.status}: ${html.slice(0, 300)}`);
  console.log(`${runtime}: application.fetch rendered the page.`);
} finally {
  await application.close();
  await rm(root, { recursive: true, force: true });
}

// The built application lives beside node_modules, where its server entry finds the installed packages.
const built = join(process.cwd(), "htmlkit-runtime-app");
if (runtime === "Node") {
  const files = {
    "package.json": '{"type":"module"}',
    "app/pages/index.html": page,
    "app/pages/greet.html": '<template component="page-greet"><defs><prop name="text" type="string" required>Text</prop><meta name="hk:render" content="server"></defs><p>{$text}</p></template>',
    "app/pages/greet.server.ts": 'export const load = ({ url, cookies }) => ({ props: { text: `Hello ${url.searchParams.get("name")}, visit ${cookies.get("visits")}` } });',
    "app/api/sum.server.ts": 'export const GET = request => { const { searchParams } = new URL(request.url); return Response.json({ sum: Number(searchParams.get("a")) + Number(searchParams.get("b")) }); };',
  };
  await rm(built, { recursive: true, force: true });
  for (const [file, contents] of Object.entries(files)) {
    await mkdir(dirname(join(built, file)), { recursive: true });
    await writeFile(join(built, file), contents);
  }
  await buildApplication({ root: built });
}
const { default: server } = await import(pathToFileURL(join(built, "dist/_htmlkit/server/entry.js")).href);
const checks = [
  ["http://localhost/", />42<\/p>/],
  ["http://localhost/greet/?name=Ada", /Hello Ada, visit 3/],
  ["http://localhost/api/sum?a=2&b=3", /^\{"sum":5\}$/],
];
for (const [url, expected] of checks) {
  const response = await server.fetch(new Request(url, { headers: { cookie: "visits=3" } }));
  const body = await response.text();
  if (response.status !== 200 || !expected.test(body)) throw new Error(`${runtime} answered ${url} with ${response.status}: ${body.slice(0, 300)}`);
}
console.log(`${runtime}: the built server entry answered a prerendered page, a server-rendered page, and an endpoint.`);
// Ends the process on runtimes where idle render workers keep it alive.
process.exit(0);
