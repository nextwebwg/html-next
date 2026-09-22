import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";

import { buildComponents, checkComponents, inspectComponents } from "../src/cli.js";
import { GENERATOR_VERSION } from "../src/generate.js";

const fixture = fileURLToPath(new URL("./fixtures/x-button.html", import.meta.url));
const graphFixture = fileURLToPath(new URL("./fixtures/graph/app.html", import.meta.url));

async function snapshot(directory: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  const visit = async (current: string, prefix = ""): Promise<void> => {
    for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      const path = join(current, entry.name);
      if (entry.isDirectory()) await visit(path, relative);
      else result[relative] = await readFile(path, "utf8");
    }
  };
  await visit(directory);
  return result;
}

describe("buildComponents", () => {
  it("builds deterministic component, documentation, and manifest artifacts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "html-next-cli-"));
    try {
      const first = await buildComponents([fixture], directory);
      const firstSnapshot = await snapshot(directory);
      const second = await buildComponents([fixture], directory);
      const secondSnapshot = await snapshot(directory);

      assert.deepEqual(first, second);
      assert.deepEqual(firstSnapshot, secondSnapshot);
      assert.deepEqual(Object.keys(firstSnapshot), [
        "docs/x-button.md",
        "html.manifest.json",
        "styles/x-button.css",
        "vanilla/XButton.d.ts",
        "vanilla/XButton.js",
        "vue/XButton.vue",
      ]);

      const manifest = JSON.parse(firstSnapshot["html.manifest.json"]!) as {
        generatorVersion: string;
        components: Array<{ name: string; tag: string; artifacts: string[] }>;
      };
      assert.equal(manifest.generatorVersion, GENERATOR_VERSION);
      assert.equal(manifest.components[0]?.name, "XButton");
      assert.equal(manifest.components[0]?.tag, "x-button");
      assert.equal(manifest.components[0]?.artifacts.length, 5);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects an empty build and colliding generated paths", async () => {
    const directory = await mkdtemp(join(tmpdir(), "html-next-cli-errors-"));
    try {
      await assert.rejects(() => buildComponents([], directory), /at least one component/i);
      await assert.rejects(
        () => buildComponents([fixture, fixture], directory),
        /generated artifact collision/i,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("checks and inspects transitive component and controller graphs without execution", async () => {
    const checked = await checkComponents([graphFixture]);
    const inspected = await inspectComponents([graphFixture]);
    assert.deepEqual(checked, inspected);
    assert.deepEqual(inspected.components.map((component) => component.tag), ["x-app", "x-child"]);
    assert.match(inspected.components[0]!.controller!, /tests\/fixtures\/graph\/app\.js$/);
    assert.deepEqual(inspected.modules.map((path) => path.split("/").at(-1)), ["app.js", "helper.js"]);
  });

  it("builds selected targets from a complete graph and copies static controller modules", async () => {
    const directory = await mkdtemp(join(tmpdir(), "html-next-cli-graph-"));
    try {
      const manifest = await buildComponents([graphFixture], directory, { targets: ["vue"] });
      const files = await snapshot(directory);
      assert.deepEqual(Object.keys(files), [
        "controllers/x-app/app.js",
        "controllers/x-app/helper.js",
        "html.manifest.json",
        "vue/XApp.vue",
        "vue/XChild.vue",
      ]);
      assert.deepEqual(manifest.components.map((component) => component.tag), ["x-app", "x-child"]);
      assert.match(files["vue/XApp.vue"]!, /\.\.\/controllers\/x-app\/app\.js/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
