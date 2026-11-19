import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ComponentDefinition } from "../../html-next/src/template.js";

/** Bundle the catalog's actual producer modules with the current SDK's public driver APIs. */
export async function buildPreparationService(directory: string, prepared: { nativeDefinitions: string; nativeAssets: string }, looma: string) {
  const workspace = fileURLToPath(new URL("../../../", import.meta.url));
  const require = createRequire(path.join(looma, "package.json"));
  const sdk = createRequire(path.join(workspace, "packages/html-next/package.json"));
  const { build } = await import(require.resolve("vite"));
  const definitions = JSON.parse(await readFile(prepared.nativeDefinitions, "utf8")) as ComponentDefinition[];
  const manifest = JSON.parse(await readFile(prepared.nativeAssets, "utf8")) as { server: { preparedModules: { tag: string }[] } };
  const tags = new Set(manifest.server.preparedModules.map(item => item.tag));
  const modules = definitions.filter(definition => tags.has(definition.contract.tag));
  const entry = path.join(directory, "preparation-service.js");
  await writeFile(entry, [
    ...modules.map((definition, index) => `import * as module${index} from ${JSON.stringify(path.resolve(path.dirname(definition.source.file), definition.module ?? definition.controller!))};`),
    `export const modules = {${modules.map((definition, index) => `${JSON.stringify(definition.contract.tag)}: module${index}`).join(",")}};`,
    `export const contracts = ${JSON.stringify(Object.fromEntries(modules.map(definition => [definition.contract.tag, definition.contract])))};`,
    'export { parseTypedValue, selectedPropType } from "@nextwebwg/html-next";',
    'export { encodeHydrationValue, decodeHydrationValue } from "@nextwebwg/html-next/bindings";',
    'export { createInputPort, INPUT_PORT } from "@nextwebwg/html-next/inputs";',
    `export { signal, effect, untracked, batch } from ${JSON.stringify(sdk.resolve("@preact/signals-core"))};`,
  ].join("\n"));
  const pkg = JSON.parse(await readFile(path.join(workspace, "packages/html-next/package.json"), "utf8")) as { exports: Record<string, { import: string }> };
  const alias = Object.entries(pkg.exports).map(([name, value]) => ({ find: name === "." ? "@nextwebwg/html-next" : "@nextwebwg/html-next" + name.slice(1),
    replacement: path.resolve(workspace, "packages/html-next", value.import) })).sort((a, b) => b.find.length - a.find.length);
  const outDir = path.join(directory, "preparation-service");
  await build({ root: looma, configFile: false, logLevel: "warn", resolve: { alias }, ssr: { noExternal: true },
    build: { ssr: entry, outDir, minify: false, rollupOptions: { output: { format: "es", entryFileNames: "service.js" } } } });
  return path.join(outDir, "service.js");
}
