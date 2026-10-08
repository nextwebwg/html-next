// Serves a generated page through application.fetch on the current runtime (Node, Deno, or Bun).
// Run from packages/htmlkit after building: node|bun scripts/runtime-smoke.mjs, deno run -A scripts/runtime-smoke.mjs.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApplication } from "../dist/index.js";

const runtime = globalThis.Deno ? "Deno" : globalThis.Bun ? "Bun" : "Node";
const root = await mkdtemp(join(tmpdir(), "htmlkit-runtime-"));
await writeFile(join(root, "package.json"), '{"type":"module"}');
const page = join(root, "page.html");
const application = await createApplication({ root, fileRoutes: false, generate: () => ({
  routes: [{ pattern: "/", component: page, server: { load: () => ({ props: { count: 21 } }) } }],
  files: new Map([[page, '<template component="page-smoke"><defs><prop name="count" type="number" required>Count</prop></defs><p $value="$count * 2"></p></template>']]),
}) });
try {
  const response = await application.fetch(new Request("http://localhost/"));
  const html = await response.text();
  if (response.status !== 200 || !/>42<\/p>/.test(html)) throw new Error(`${runtime} rendered ${response.status}: ${html.slice(0, 300)}`);
  console.log(`${runtime}: application.fetch rendered the generated page.`);
} finally {
  await application.close();
  await rm(root, { recursive: true, force: true });
}
// The DOM worker pool would otherwise keep the process alive.
process.exit(0);
