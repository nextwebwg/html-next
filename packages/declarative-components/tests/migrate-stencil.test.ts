import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";

import { migrateStencilPackage } from "../src/cli.js";
import { extractStencilInventory, scaffoldStencilComponent, stencilTypeToHtmlNext } from "../src/migrate/stencil.js";

const fixtureRoot = fileURLToPath(new URL("./fixtures/stencil/", import.meta.url));

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

  it("maps safe public types and reports reviewed work in generated scaffolds", async () => {
    assert.equal(stencilTypeToHtmlNext("string | null | undefined"), "string | null | absent");
    assert.equal(stencilTypeToHtmlNext("readonly Option[]"), "list(unknown)");
    assert.equal(stencilTypeToHtmlNext("(value: string) => void"), "function");
    const inventory = await extractStencilInventory({
      root: fixtureRoot,
      typesFile: `${fixtureRoot}/components.d.ts`,
      manifestFile: `${fixtureRoot}/collection-manifest.json`,
      facadePackageFile: `${fixtureRoot}/package.json`,
    });
    const scaffold = scaffoldStencilComponent(inventory.components[0]!);
    assert.match(scaffold.source, /<template component="ui-example"/);
    assert.match(scaffold.source, /type="unknown"/);
    assert.deepEqual(scaffold.diagnostics.map((diagnostic) => diagnostic.code), ["HM001", "HM002"]);
  });

  it("copies component CSS beside review-required migration scaffolds", async () => {
    const directory = await mkdtemp(join(tmpdir(), "html-next-migrate-"));
    try {
      await migrateStencilPackage(fixtureRoot, directory, {
        typesFile: `${fixtureRoot}/components.d.ts`,
        manifestFile: `${fixtureRoot}/collection-manifest.json`,
        facadePackageFile: `${fixtureRoot}/package.json`,
      });
      assert.match(await readFile(join(directory, "ui-example.html"), "utf8"), /component="ui-example"/);
      assert.equal(
        await readFile(join(directory, "styles/ui-example/ui-example.css"), "utf8"),
        await readFile(join(fixtureRoot, "packages/core/src/components/ui-example/ui-example.css"), "utf8"),
      );
      const review = JSON.parse(await readFile(join(directory, "ui-example.migration.json"), "utf8")) as { styles: string[] };
      assert.deepEqual(review.styles, ["styles/ui-example/ui-example.css"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
