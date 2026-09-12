import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { assembleComponentPackage } from "../src/package.js";

const fixture = new URL("./fixtures/package/", import.meta.url).pathname;
const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function assemble() {
  const outDirectory = await mkdtemp(join(tmpdir(), "html-next-package-"));
  temporary.push(outDirectory);
  const result = await assembleComponentPackage({
    name: "@example/looma-next",
    version: "1.0.0",
    outDirectory,
    components: [
      { source: `${fixture}/ui-input.html` },
      { source: `${fixture}/ui-button.html` },
    ],
    passThrough: [{ source: `${fixture}/tokens.css`, target: "tokens.css" }],
  });
  return { outDirectory, result };
}

describe("component package assembler", () => {
  it("emits deterministic generated, registration, inventory, and pass-through edges", async () => {
    const first = await assemble();
    const second = await assemble();
    assert.deepEqual(first.result, second.result);
    assert.deepEqual(first.result.components, ["ui-button", "ui-input"]);
    assert.ok(first.result.files.includes("dist/index.js"));
    assert.ok(first.result.files.includes("vue/UiButton.vue"));
    assert.ok(first.result.files.includes("components/ui-input.html"));
    assert.equal(await readFile(`${first.outDirectory}/tokens.css`, "utf8"), ":root { --looma-accent: rebeccapurple; }\n");

    const entry = await readFile(`${first.outDirectory}/dist/index.js`, "utf8");
    assert.match(entry, /registerComponentDefinitions/);
    assert.match(entry, /typeof document === 'undefined'/);
    assert.doesNotMatch(entry, /html-next-package-/);

    const manifest = JSON.parse(await readFile(`${first.outDirectory}/html.manifest.json`, "utf8")) as {
      components: Array<{ tag: string; source: string }>;
      passThrough: string[];
    };
    assert.deepEqual(manifest.components.map((component) => component.tag), ["ui-button", "ui-input"]);
    assert.deepEqual(manifest.components.map((component) => component.source), [
      "./components/ui-button.html", "./components/ui-input.html",
    ]);
    assert.deepEqual(manifest.passThrough, ["tokens.css"]);
  });

  it("rejects output escapes and artifact collisions", async () => {
    const outDirectory = await mkdtemp(join(tmpdir(), "html-next-package-"));
    temporary.push(outDirectory);
    await assert.rejects(() => assembleComponentPackage({
      name: "@example/bad",
      version: "1.0.0",
      outDirectory,
      components: [{ source: `${fixture}/ui-button.html` }],
      passThrough: [{ source: `${fixture}/tokens.css`, target: "../outside.css" }],
    }), /escaped/);
    await assert.rejects(() => assembleComponentPackage({
      name: "@example/bad",
      version: "1.0.0",
      outDirectory,
      components: [{ source: `${fixture}/ui-button.html` }],
      passThrough: [{ source: `${fixture}/tokens.css`, target: "styles/ui-button.css" }],
    }), /collision/);
  });
});
