import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { buildComponents } from "../src/cli.js";

const fixture = new URL("./fixtures/x-button.html", import.meta.url).pathname;

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
        "react/XButton.tsx",
        "styles/x-button.css",
        "svelte/XButton.svelte",
        "vanilla/XButton.d.ts",
        "vanilla/XButton.js",
        "vue/XButton.vue",
      ]);

      const manifest = JSON.parse(firstSnapshot["html.manifest.json"]!) as {
        generatorVersion: string;
        components: Array<{ name: string; tag: string; artifacts: string[] }>;
      };
      assert.equal(manifest.generatorVersion, "0.0.0");
      assert.equal(manifest.components[0]?.name, "XButton");
      assert.equal(manifest.components[0]?.tag, "x-button");
      assert.equal(manifest.components[0]?.artifacts.length, 7);
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
});
