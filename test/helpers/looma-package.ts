import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { assembleLoomaPackage } from "../../src/migrate/looma-package.js";
import type { StencilPackageInventory } from "../../src/migrate/stencil.js";

const inventory = JSON.parse(await readFile(new URL("../fixtures/looma/inventory.json", import.meta.url), "utf8")) as StencilPackageInventory;
const componentsDirectory = new URL("../../examples/looma/components/", import.meta.url).pathname;
const layoutDirectory = new URL("../../examples/looma/layout/", import.meta.url).pathname;
const assetsDirectory = new URL("../../examples/looma/package-assets/", import.meta.url).pathname;
const ordinaryDirectory = new URL("../fixtures/looma/ordinary/", import.meta.url).pathname;

const ordinaryModules = [
  ["editor.js", "editor/index.js", true], ["editor.d.ts", "editor/index.d.ts", false],
  ["editor-ui.js", "editor/ui.js", true], ["editor-ui.d.ts", "editor/ui.d.ts", false],
  ["extensions.js", "editor/extensions/index.js", true], ["extensions.d.ts", "editor/extensions/index.d.ts", false],
  ["vue-editor.js", "vue/editor/index.js", true], ["vue-editor.d.ts", "vue/editor/index.d.ts", false],
  ["valibot.js", "dist/valibot.js", true], ["valibot.d.ts", "dist/valibot.d.ts", false],
] as const;

export function assembleFixtureLooma(outDirectory: string) {
  return assembleLoomaPackage({
    outDirectory, inventory, componentsDirectory, layoutDirectory, assetsDirectory,
    ordinaryModules: ordinaryModules.map(([source, target, module]) => ({ source: join(ordinaryDirectory, source), target, module })),
  });
}

export { assetsDirectory, inventory };
