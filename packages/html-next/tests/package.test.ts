import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "vitest";

import { assembleComponentPackage } from "../src/package.js";

const fixture = fileURLToPath(new URL("./fixtures/package/", import.meta.url));
const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function assemble() {
  const outDirectory = await mkdtemp(join(tmpdir(), "html-next-package-"));
  temporary.push(outDirectory);
  const result = await assembleComponentPackage({
    name: "@example/component-library",
    version: "1.0.0",
    outDirectory,
    components: [
      { source: `${fixture}/ui-input.html` },
      { source: `${fixture}/ui-button.html` },
      { source: `${fixture}/ui-overlay.html` },
    ],
    passThrough: [
      { source: `${fixture}/tokens.css`, target: "tokens.css" },
      { source: `${fixture}/editor.js`, target: "editor/extensions/index.js", module: true },
    ],
  });
  return { outDirectory, result };
}

describe("component package assembler", () => {
  it("emits deterministic generated, registration, inventory, and pass-through edges", async () => {
    const first = await assemble();
    const second = await assemble();
    assert.deepEqual(first.result, second.result);
    assert.deepEqual(first.result.components, ["ui-button", "ui-input", "ui-overlay"]);
    assert.ok(first.result.files.includes("dist/index.js"));
    assert.ok(first.result.files.includes("vue/UiButton.vue"));
    assert.ok(first.result.files.includes("components/ui-input.html"));
    assert.ok(first.result.files.includes("components/ui-overlay.js"));
    assert.ok(first.result.files.includes("components/overlay-helper.js"));
    assert.ok(first.result.files.includes("vue/index.js"));
    assert.ok(first.result.files.includes("editor/extensions/editor-helper.js"));
    assert.match(await readFile(`${first.outDirectory}/components/ui-overlay.js`, "utf8"), /\.\/overlay-helper\.js/);
    // A source keeps its dependency links, which resolve beside it.
    assert.match(await readFile(`${first.outDirectory}/components/ui-overlay.html`, "utf8"), /<link rel="component" href="\.\/ui-button\.html">/);
    assert.match(await readFile(`${first.outDirectory}/vue/UiOverlay.vue`, "utf8"), /from '\.\.\/components\/ui-overlay\.js'/);
    assert.equal(await readFile(`${first.outDirectory}/tokens.css`, "utf8"), ":root { --component-accent: rebeccapurple; }\n");

    const entry = await readFile(`${first.outDirectory}/dist/index.js`, "utf8");
    assert.match(entry, /registerComponentDefinitions/);
    assert.match(entry, /typeof document === 'undefined'/);
    assert.doesNotMatch(entry, /html-next-package-/);

    const manifest = JSON.parse(await readFile(`${first.outDirectory}/html.manifest.json`, "utf8")) as {
      components: Array<{ tag: string; source: string }>;
      passThrough: string[];
      controllerModules: Array<{ path: string; dependencies: string[] }>;
      passThroughModules: Array<{ path: string; dependencies: string[] }>;
    };
    assert.deepEqual(manifest.components.map((component) => component.tag), ["ui-button", "ui-input", "ui-overlay"]);
    assert.deepEqual(manifest.components.map((component) => component.source), [
      "./components/ui-button.html", "./components/ui-input.html", "./components/ui-overlay.html",
    ]);
    assert.deepEqual(manifest.passThrough, ["editor/extensions/index.js", "tokens.css"]);
    assert.deepEqual(manifest.controllerModules, [
      { path: "components/overlay-helper.js", dependencies: [] },
      { path: "components/ui-overlay.js", dependencies: ["./overlay-helper.js"] },
    ]);
    assert.deepEqual(manifest.passThroughModules, [
      { path: "editor/extensions/editor-helper.js", dependencies: [] },
      { path: "editor/extensions/index.js", dependencies: ["./editor-helper.js"] },
    ]);
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
