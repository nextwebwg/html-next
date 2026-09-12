import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import { scaffoldStencilComponent, type StencilPackageInventory } from "../src/migrate/stencil.js";
import { LOOMA_PORTED_TAGS, migrateLoomaComponent } from "../src/migrate/looma.js";
import { parseComponent } from "../src/parser.js";

const inventoryUrl = new URL("./fixtures/looma/inventory.json", import.meta.url);

describe("checked-in Looma migration surface", () => {
  it("accounts for all 34 published core components and facade exports", async () => {
    const inventory = JSON.parse(await readFile(inventoryUrl, "utf8")) as StencilPackageInventory;
    assert.equal(inventory.schemaVersion, 1);
    assert.equal(inventory.components.length, 34);
    assert.equal(new Set(inventory.components.map((component) => component.tag)).size, 34);
    assert.ok(inventory.package.exports.includes("./vue"));
    assert.ok(inventory.package.exports.includes("./editor/extensions"));
    assert.ok(inventory.package.exports.includes("./tokens.css"));
    for (const component of inventory.components) {
      assert.match(component.tag, /^ui-[a-z0-9-]+$/);
      assert.ok(component.registrationEntry.endsWith(`${component.tag}.js`));
      assert.ok(component.styles.length > 0, `${component.tag} must account for its component CSS`);
    }
  });

  it("records the high-risk migration surfaces explicitly", async () => {
    const inventory = JSON.parse(await readFile(inventoryUrl, "utf8")) as StencilPackageInventory;
    const byTag = new Map(inventory.components.map((component) => [component.tag, component]));
    assert.ok(byTag.get("ui-combobox")!.capabilities.includes("data-derived-slots"));
    assert.ok(byTag.get("ui-combobox")!.capabilities.includes("async"));
    assert.deepEqual(byTag.get("ui-combobox")!.methods.map((method) => method.name), ["focusInput", "validate"]);
    assert.ok(byTag.get("ui-dialog")!.capabilities.includes("overlay"));
    assert.ok(byTag.get("ui-tree")!.capabilities.includes("keyboard-focus"));
    assert.ok(byTag.get("ui-input")!.capabilities.includes("form-control"));
  });

  it("produces a parseable scaffold for every component without calling it converted", async () => {
    const inventory = JSON.parse(await readFile(inventoryUrl, "utf8")) as StencilPackageInventory;
    for (const component of inventory.components) {
      const scaffold = scaffoldStencilComponent(component);
      assert.equal(parseComponent(scaffold.source, `${component.tag}.html`).contract.tag, component.tag);
      assert.ok(scaffold.diagnostics.some((diagnostic) => diagnostic.code === "HM001"));
    }
  });

  it("keeps reviewed ports distinct from migration scaffolds", async () => {
    const inventory = JSON.parse(await readFile(inventoryUrl, "utf8")) as StencilPackageInventory;
    const migrations = inventory.components.map(migrateLoomaComponent);
    assert.equal(migrations.filter((migration) => migration.status === "ported").length, LOOMA_PORTED_TAGS.length);
    for (const [index, migration] of migrations.entries()) {
      parseComponent(migration.source, inventory.components[index]!.tag);
      assert.equal(migration.diagnostics.length === 0, migration.status === "ported");
    }
  });
});
