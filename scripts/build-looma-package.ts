import { resolve, join } from "node:path";

import { assembleLoomaPackage } from "../src/migrate/looma-package.js";
import { extractStencilInventory } from "../src/migrate/stencil.js";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const source = option("--source") ?? process.env.LOOMA_SOURCE;
const outDirectory = option("--out-dir");
if (!source || !outDirectory) {
  throw new Error("Usage: npm run build:looma -- --source <looma-checkout> --out-dir <directory>");
}

const sourceRoot = resolve(source);
const facade = join(sourceRoot, "packages/looma");
const ordinary = [
  ["editor/index.js", "editor/index.js", true],
  ["editor/index.d.ts", "editor/index.d.ts", false],
  ["editor/ui.js", "editor/ui.js", true],
  ["editor/ui.d.ts", "editor/ui.d.ts", false],
  ["editor/extensions/index.js", "editor/extensions/index.js", true],
  ["editor/extensions/index.d.ts", "editor/extensions/index.d.ts", false],
  ["vue/editor/index.js", "vue/editor/index.js", true],
  ["vue/editor/index.d.ts", "vue/editor/index.d.ts", false],
  ["dist/valibot.js", "dist/valibot.js", true],
  ["dist/valibot.d.ts", "dist/valibot.d.ts", false],
] as const;

const inventory = await extractStencilInventory({ root: sourceRoot });
const assembled = await assembleLoomaPackage({
  outDirectory: resolve(outDirectory),
  inventory,
  componentsDirectory: new URL("../examples/looma/components/", import.meta.url).pathname,
  layoutDirectory: new URL("../examples/looma/layout/", import.meta.url).pathname,
  assetsDirectory: new URL("../examples/looma/package-assets/", import.meta.url).pathname,
  ordinaryModules: ordinary.map(([sourcePath, target, module]) => ({
    source: join(facade, sourcePath),
    target,
    module,
  })),
});

process.stdout.write(`Built ${assembled.components.length} definitions and ${assembled.files.length} files in ${resolve(outDirectory)}.\n`);
