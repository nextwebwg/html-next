import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { extractStencilInventory } from "../src/migrate/stencil.js";

const sourceIndex = process.argv.indexOf("--source");
const source = sourceIndex === -1 ? process.env.LOOMA_SOURCE : process.argv[sourceIndex + 1];
if (source === undefined || source === "") {
  throw new Error("Set LOOMA_SOURCE or pass --source with a Looma repository checkout.");
}
const output = new URL("../test/fixtures/looma/inventory.json", import.meta.url);
const serialized = `${JSON.stringify(await extractStencilInventory({ root: source }), null, 2)}\n`;
if (process.argv.includes("--check")) {
  const current = await readFile(output, "utf8");
  if (current !== serialized) throw new Error("The checked-in Looma inventory is stale.");
} else {
  await mkdir(dirname(output.pathname), { recursive: true });
  await writeFile(output, serialized, "utf8");
}
