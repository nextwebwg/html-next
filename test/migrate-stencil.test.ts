import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { extractStencilInventory } from "../src/migrate/stencil.js";

const fixtureRoot = new URL("./fixtures/stencil/", import.meta.url).pathname;

describe("Stencil migration inventory", () => {
  it("extracts public shape plus source-observable slots, styles, and capabilities", async () => {
    const inventory = await extractStencilInventory({
      root: fixtureRoot,
      typesFile: `${fixtureRoot}/components.d.ts`,
      manifestFile: `${fixtureRoot}/collection-manifest.json`,
      facadePackageFile: `${fixtureRoot}/package.json`,
    });

    assert.deepEqual(inventory.package, {
      name: "@example/components",
      version: "1.2.3",
      exports: [".", "./styles.css"],
    });
    assert.deepEqual(inventory.components[0], {
      tag: "ui-example",
      interfaceName: "UiExample",
      source: "packages/core/src/components/ui-example/ui-example.tsx",
      registrationEntry: "components/ui-example/ui-example.js",
      description: "Example control.",
      props: [
        { name: "defaultValue", type: "string", required: false, default: "''", description: "" },
        { name: "value", type: "string", required: false, description: "Controlled value." },
      ],
      events: [{ name: "value-change", detailType: "{ value: string }" }],
      methods: [{ name: "focusInput", returns: "Promise<void>" }],
      slots: [
        { name: "item-${...}", dynamic: true },
        { name: "label", dynamic: false },
      ],
      styles: ["packages/core/src/components/ui-example/ui-example.css"],
      capabilities: [
        "async", "controlled-uncontrolled", "data-derived-slots", "events", "form-control",
        "keyboard-focus", "methods", "props", "slots", "styles",
      ],
    });
  });
});
