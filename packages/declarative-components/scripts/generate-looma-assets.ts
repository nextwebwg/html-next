import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { loomaStyleRoots, migrateLoomaStyles } from "../src/migrate/looma-css.js";
import type { StencilPackageInventory } from "../src/migrate/stencil.js";
import { parseComponent } from "../src/parser.js";

const sourceIndex = process.argv.indexOf("--source");
const source = sourceIndex === -1 ? process.env.LOOMA_SOURCE : process.argv[sourceIndex + 1];
if (!source) throw new Error("Set LOOMA_SOURCE or pass --source with a Looma repository checkout.");
const output = new URL("../examples/looma/package-assets/", import.meta.url);
const inventory = JSON.parse(await readFile(new URL("../test/fixtures/looma/inventory.json", import.meta.url), "utf8")) as StencilPackageInventory;
const definitions = new Map(await Promise.all(inventory.components.map(async (component) => {
  const definition = parseComponent(
    await readFile(new URL(`../examples/looma/components/${component.tag}.html`, import.meta.url), "utf8"),
    component.tag,
  );
  const classAttribute = definition.template.attributes.find((attribute) =>
    attribute.kind === "literal" && attribute.name === "class"
  );
  return [component.tag, {
    element: definition.template.name,
    classes: classAttribute?.kind === "literal" ? classAttribute.value.split(/\s+/).filter(Boolean) : [],
  }] as const;
})));
const copies = [
  "tokens.css", "theme-light.css", "theme-dark.css", "theme-high-contrast.css", "editor.css",
] as const;
await mkdir(output, { recursive: true });
const assets = new Map<string, string>(await Promise.all(copies.map(async (name) => [
  name,
  await readFile(join(source, "packages/looma", name), "utf8"),
] as const)));
assets.set("styles.css", migrateLoomaStyles(
  await readFile(join(source, "packages/looma/styles.css"), "utf8"),
  loomaStyleRoots(inventory.components, definitions),
));
assets.set("layout.css", migrateLoomaStyles(
  await readFile(join(source, "packages/looma/layout.css"), "utf8"),
  [
    { tag: "ui-stack", element: "div", classes: [], props: ["gap", "align", "justify"] },
    { tag: "ui-inline", element: "div", classes: [], props: ["gap", "align", "justify", "wrap"] },
    { tag: "ui-cluster", element: "div", classes: [], props: ["gap", "align", "justify"] },
    { tag: "ui-grid", element: "div", classes: [], props: ["gap", "min"] },
    { tag: "ui-center", element: "div", classes: [], props: ["measure", "gutters"] },
    { tag: "ui-switcher", element: "div", classes: [], props: ["gap", "threshold", "align"] },
    { tag: "ui-sidebar", element: "div", classes: ["sidebar"], props: ["gap", "side", "width", "align", "resizable"] },
    { tag: "ui-reel", element: "div", classes: [], props: ["gap", "itemWidth", "snap"] },
    { tag: "ui-separator", element: "hr", classes: [], props: ["orientation"] },
  ],
));
for (const [name, content] of assets) {
  const target = new URL(name, output);
  if (process.argv.includes("--check")) {
    if (await readFile(target, "utf8") !== content) throw new Error(`The checked-in Looma ${name} asset is stale.`);
  } else await writeFile(target, content, "utf8");
}
