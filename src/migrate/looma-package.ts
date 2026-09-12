import { join } from "node:path";

import { assembleComponentPackage, type AssembledPackage } from "../package.js";
import type { PackagePassThrough } from "../package-config.js";
import { LOOMA_PORTED_TAGS } from "./looma.js";
import type { StencilPackageInventory } from "./stencil.js";

const LAYOUT_TAGS = Object.freeze([
  "ui-center", "ui-cluster", "ui-grid", "ui-inline", "ui-reel", "ui-separator", "ui-sidebar", "ui-stack", "ui-switcher",
]);

const CSS_ASSETS = Object.freeze([
  "tokens.css", "theme-light.css", "theme-dark.css", "theme-high-contrast.css", "layout.css", "styles.css", "editor.css",
]);

export interface LoomaPackageOptions {
  readonly outDirectory: string;
  readonly inventory: StencilPackageInventory;
  readonly componentsDirectory: string;
  readonly layoutDirectory: string;
  readonly assetsDirectory: string;
  readonly ordinaryModules: readonly PackagePassThrough[];
}

/** Builds the published Looma facade shape only when all public core definitions are reviewed ports. */
export async function assembleLoomaPackage(options: LoomaPackageOptions): Promise<AssembledPackage> {
  const inventoryTags = options.inventory.components.map((component) => component.tag).sort();
  if (inventoryTags.length !== 34 || inventoryTags.join("\0") !== [...LOOMA_PORTED_TAGS].sort().join("\0")) {
    throw new Error("Looma package assembly requires reviewed ports for all 34 public core components.");
  }
  const targets = new Set(options.ordinaryModules.map((edge) => edge.target));
  const required = [
    "editor/index.js", "editor/index.d.ts", "editor/ui.js", "editor/ui.d.ts",
    "editor/extensions/index.js", "editor/extensions/index.d.ts",
    "vue/editor/index.js", "vue/editor/index.d.ts", "dist/valibot.js", "dist/valibot.d.ts",
  ];
  const missing = required.filter((target) => !targets.has(target));
  if (missing.length > 0) throw new Error(`Looma ordinary package edges are missing: ${missing.join(", ")}.`);
  return assembleComponentPackage({
    name: options.inventory.package.name,
    version: options.inventory.package.version,
    outDirectory: options.outDirectory,
    components: [
      ...inventoryTags.map((tag) => ({ source: join(options.componentsDirectory, `${tag}.html`) })),
      ...LAYOUT_TAGS.map((tag) => ({ source: join(options.layoutDirectory, `${tag}.html`) })),
    ],
    passThrough: [
      ...CSS_ASSETS.map((name) => ({ source: join(options.assetsDirectory, name), target: name })),
      ...options.ordinaryModules,
    ],
    exports: {
      ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
      "./core": { types: "./dist/index.d.ts", import: "./dist/index.js" },
      "./loader": { types: "./dist/index.d.ts", import: "./dist/index.js" },
      "./layout": { types: "./dist/index.d.ts", import: "./dist/index.js" },
      "./editor": { types: "./editor/index.d.ts", import: "./editor/index.js" },
      "./editor/ui": { types: "./editor/ui.d.ts", import: "./editor/ui.js" },
      "./editor/extensions": { types: "./editor/extensions/index.d.ts", import: "./editor/extensions/index.js" },
      "./vue": { types: "./vue/index.d.ts", import: "./vue/index.js" },
      "./vue/editor": { types: "./vue/editor/index.d.ts", import: "./vue/editor/index.js" },
      "./valibot": { types: "./dist/valibot.d.ts", import: "./dist/valibot.js" },
      "./components/*": "./components/*",
      "./tokens.css": "./tokens.css", "./theme-light.css": "./theme-light.css",
      "./theme-dark.css": "./theme-dark.css", "./theme-high-contrast.css": "./theme-high-contrast.css",
      "./layout.css": "./layout.css", "./styles.css": "./styles.css", "./editor.css": "./editor.css",
    },
    peerDependencies: {
      vue: "^3.5.0", "@tiptap/core": ">=2 <3", "@tiptap/pm": ">=2 <3", "@tiptap/vue-3": ">=2 <3",
    },
    peerDependenciesMeta: {
      vue: { optional: true }, "@tiptap/core": { optional: true }, "@tiptap/pm": { optional: true }, "@tiptap/vue-3": { optional: true },
    },
  });
}
