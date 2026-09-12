import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { assembleLoomaPackage } from "../src/migrate/looma-package.js";
import type { StencilPackageInventory } from "../src/migrate/stencil.js";

const enabled = process.env.HTMLNEXT_LOOMA_TEST === "1";
const inventory = JSON.parse(await readFile(new URL("./fixtures/looma/inventory.json", import.meta.url), "utf8")) as StencilPackageInventory;
const componentsDirectory = new URL("../examples/looma/components/", import.meta.url).pathname;
const layoutDirectory = new URL("../examples/looma/layout/", import.meta.url).pathname;
const assetsDirectory = new URL("../examples/looma/package-assets/", import.meta.url).pathname;
const ordinaryDirectory = new URL("./fixtures/looma/ordinary/", import.meta.url).pathname;

const ordinaryModules = [
  ["editor.js", "editor/index.js", true], ["editor.d.ts", "editor/index.d.ts", false],
  ["editor-ui.js", "editor/ui.js", true], ["editor-ui.d.ts", "editor/ui.d.ts", false],
  ["extensions.js", "editor/extensions/index.js", true], ["extensions.d.ts", "editor/extensions/index.d.ts", false],
  ["vue-editor.js", "vue/editor/index.js", true], ["vue-editor.d.ts", "vue/editor/index.d.ts", false],
  ["valibot.js", "dist/valibot.js", true], ["valibot.d.ts", "dist/valibot.d.ts", false],
] as const;

describe("complete Looma compatibility package", { skip: !enabled }, () => {
  let directory = "";

  before(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-looma-package-"));
    await assembleLoomaPackage({
      outDirectory: directory, inventory, componentsDirectory, layoutDirectory, assetsDirectory,
      ordinaryModules: ordinaryModules.map(([source, target, module]) => ({
        source: join(ordinaryDirectory, source), target, module,
      })),
    });
  });

  after(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

  it("emits all core and layout definitions through the published facade shape", async () => {
    const manifest = JSON.parse(await readFile(join(directory, "html.manifest.json"), "utf8")) as {
      components: Array<{ tag: string }>;
      passThroughModules: Array<{ path: string; dependencies: string[] }>;
    };
    assert.equal(manifest.components.length, 43);
    assert.equal(manifest.components.filter((component) => inventory.components.some((item) => item.tag === component.tag)).length, 34);
    assert.ok(manifest.components.some((component) => component.tag === "ui-sidebar"));
    assert.deepEqual(manifest.passThroughModules.find((module) => module.path === "editor/extensions/index.js"), {
      path: "editor/extensions/index.js", dependencies: ["./extension-helper.js"],
    });
    const packageJson = JSON.parse(await readFile(join(directory, "package.json"), "utf8")) as { exports: Record<string, unknown> };
    for (const path of inventory.package.exports) assert.ok(path in packageJson.exports, `missing ${path}`);
    assert.match(await readFile(join(directory, "vue/index.js"), "utf8"), /default as Combobox/);
    assert.match(await readFile(join(directory, "layout.css"), "utf8"), /data-component-root~="ui-stack"/);
  });

  it("rejects an incomplete ordinary-module facade", async () => {
    await assert.rejects(() => assembleLoomaPackage({
      outDirectory: join(directory, "incomplete"), inventory, componentsDirectory, layoutDirectory, assetsDirectory,
      ordinaryModules: [],
    }), /ordinary package edges are missing/);
  });
});
