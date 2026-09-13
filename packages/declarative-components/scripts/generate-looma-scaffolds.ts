import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";

import { migrateLoomaComponent } from "../src/migrate/looma.js";
import type { StencilPackageInventory } from "../src/migrate/stencil.js";

const inventoryUrl = new URL("../tests/fixtures/looma/inventory.json", import.meta.url);
const outputUrl = new URL("../examples/looma/components/", import.meta.url);
const reviewUrl = new URL("../examples/looma/migration-review.json", import.meta.url);
const supportAssetsUrl = new URL("../src/migrate/looma-assets/", import.meta.url);
const inventory = JSON.parse(await readFile(inventoryUrl, "utf8")) as StencilPackageInventory;
const checking = process.argv.includes("--check");
const emit = async (target: URL, content: string): Promise<void> => {
  if (checking) {
    if (await readFile(target, "utf8") !== content) throw new Error(`${target.pathname} is stale.`);
  } else {
    await writeFile(target, content, "utf8");
  }
};
if (!checking) await mkdir(outputUrl, { recursive: true });
await Promise.all((await readdir(supportAssetsUrl)).filter((name) => name.endsWith(".js"))
  .map(async (name) => {
    const source = new URL(name, supportAssetsUrl);
    const target = new URL(name, outputUrl);
    if (checking) await emit(target, await readFile(source, "utf8"));
    else await copyFile(source, target);
  }));
const review = await Promise.all(inventory.components.map(async (component) => {
  const migration = migrateLoomaComponent(component);
  await Promise.all([
    emit(new URL(`${component.tag}.html`, outputUrl), migration.source),
    ...(migration.controller === undefined
      ? []
      : [emit(new URL(`${component.tag}.js`, outputUrl), migration.controller)]),
  ]);
  return { tag: component.tag, status: migration.status, diagnostics: migration.diagnostics };
}));
await emit(reviewUrl, `${JSON.stringify(review, null, 2)}\n`);
