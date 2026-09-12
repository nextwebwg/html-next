import { mkdir, readFile, writeFile } from "node:fs/promises";

import { migrateLoomaComponent } from "../src/migrate/looma.js";
import type { StencilPackageInventory } from "../src/migrate/stencil.js";

const inventoryUrl = new URL("../test/fixtures/looma/inventory.json", import.meta.url);
const outputUrl = new URL("../examples/looma/components/", import.meta.url);
const reviewUrl = new URL("../examples/looma/migration-review.json", import.meta.url);
const inventory = JSON.parse(await readFile(inventoryUrl, "utf8")) as StencilPackageInventory;
await mkdir(outputUrl, { recursive: true });
const review = await Promise.all(inventory.components.map(async (component) => {
  const migration = migrateLoomaComponent(component);
  await Promise.all([
    writeFile(new URL(`${component.tag}.html`, outputUrl), migration.source, "utf8"),
    ...(migration.controller === undefined
      ? []
      : [writeFile(new URL(`${component.tag}.js`, outputUrl), migration.controller, "utf8")]),
  ]);
  return { tag: component.tag, status: migration.status, diagnostics: migration.diagnostics };
}));
await writeFile(reviewUrl, `${JSON.stringify(review, null, 2)}\n`, "utf8");
