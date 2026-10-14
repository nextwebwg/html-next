// Serves a page through application.fetch on the current runtime (Node, Deno, or Bun).
// Run it in a project with the packed packages installed, as CI does: inside this workspace, Bun
// applies tsconfig paths that point @nextwebwg/html-next at its TypeScript source.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApplication } from "@nextwebwg/htmlkit";

const runtime = globalThis.Deno ? "Deno" : globalThis.Bun ? "Bun" : "Node";
const root = await mkdtemp(join(tmpdir(), "htmlkit-runtime-"));
await writeFile(join(root, "package.json"), '{"type":"module"}');
await mkdir(join(root, "app/pages"), { recursive: true });
await writeFile(join(root, "app/pages/index.html"), '<template component="page-smoke"><defs><prop name="count" type="number" default="21">Count</prop></defs><p>{$count * 2}</p></template>');
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
// The DOM worker pool would otherwise keep the process alive.
process.exit(0);
