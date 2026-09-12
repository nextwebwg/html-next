import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import type { StencilPackageInventory } from "../src/migrate/stencil.js";

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
});
