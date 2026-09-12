import { mkdir, readFile, writeFile } from "node:fs/promises";

import { migrateLoomaComponent } from "../src/migrate/looma.js";
import type { StencilPackageInventory } from "../src/migrate/stencil.js";

const inventoryUrl = new URL("../test/fixtures/looma/inventory.json", import.meta.url);
const outputUrl = new URL("../examples/looma/components/", import.meta.url);
const reviewUrl = new URL("../examples/looma/migration-review.json", import.meta.url);
const inventory = JSON.parse(await readFile(inventoryUrl, "utf8")) as StencilPackageInventory;
await mkdir(outputUrl, { recursive: true });
const review: Array<{ tag: string; status: "ported" | "scaffold"; diagnostics: unknown }> = [];
for (const component of inventory.components) {
  const migration = migrateLoomaComponent(component);
  await writeFile(new URL(`${component.tag}.html`, outputUrl), migration.source, "utf8");
  review.push({ tag: component.tag, status: migration.status, diagnostics: migration.diagnostics });
}
await writeFile(reviewUrl, `${JSON.stringify(review, null, 2)}\n`, "utf8");
