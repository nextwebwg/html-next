import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "vitest";

import { assembleComponentPackage } from "../src/package.js";
import { GENERATOR_VERSION } from "../src/generate.js";

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
  it("discovers prepared module exports without evaluating them and revisions their relative dependencies", async () => {
    const root = await mkdtemp(join(tmpdir(), "html-next-prepared-package-"));
    temporary.push(root);
    await writeFile(join(root, "card.html"), '<template component="x-card" module="./card.js"><article>Card</article></template>');
    await writeFile(join(root, "card.js"), 'throw new Error("Never execute while assembling"); export * from "./source.js";');
    await writeFile(join(root, "source.js"), 'export const { prepare, adopt } = {}; export function connect() {}');
    const outDirectory = join(root, "output");
    const assemble = () => assembleComponentPackage({ name: "@example/library", version: "1.0.0", outDirectory,
      components: [{ source: join(root, "card.html") }] });
    await assemble();
    const first = await readFile(join(outDirectory, "vue/XCard.vue"), "utf8");
    assert.match(first, /usePreparedModule/);
    assert.match(await readFile(join(outDirectory, "vue/bindings.ts"), "utf8"), /decodeHydrationValue/);
    await writeFile(join(root, "source.js"), 'export const { prepare, adopt } = {}; export function connect() { return () => {}; }');
    await assemble();
    const second = await readFile(join(outDirectory, "vue/XCard.vue"), "utf8");
    assert.notEqual(first, second, "a changed relative module invalidates prepared transfer identities");
  });

  it("relocates named component modules without creating a legacy controller", async () => {
    const root = await mkdtemp(join(tmpdir(), "html-next-module-package-"));
    temporary.push(root);
    await writeFile(join(root, "card.html"), '<template component="x-card" module="./card.js"><article>Card</article></template>');
    await writeFile(join(root, "card.js"), 'export function connect() {}');
    const outDirectory = join(root, "output");
    await assembleComponentPackage({ name: "@example/library", version: "1.0.0", outDirectory,
      components: [{ source: join(root, "card.html") }], hostTypes: true });
    const vanilla = await readFile(join(outDirectory, "vanilla/XCard.js"), "utf8");
    assert.match(vanilla, /import \* as controller from "\.\.\/components\/card.js"/);
    assert.match(vanilla, /activateModule\(controller, host\)/);
    assert.doesNotMatch(vanilla, /controller.default/);
    assert.match(await readFile(join(root, "x-card.host.d.ts"), "utf8"), /export type Connect = .*signal: AbortSignal/);
    const registration = await readFile(join(outDirectory, "dist/index.js"), "utf8");
    assert.match(registration, /activateModule\(value, host\)/);
  });
  it("packages every component from one source and preserves their declared names", async () => {
    const root = await mkdtemp(join(tmpdir(), "html-next-multi-package-"));
    temporary.push(root);
    const source = '<template component="ui-button" status="early" summary="Button."><button>Save</button></template>' +
      '<template component="ui-dialog" status="early" summary="Dialog."><section>Dialog</section></template>';
    await writeFile(join(root, "library.html"), source);
    const outDirectory = join(root, "output");
    const result = await assembleComponentPackage({ name: "@example/library", version: "1.0.0", outDirectory,
      components: [{ source: join(root, "library.html") }] });
    assert.deepEqual(result.components, ["ui-button", "ui-dialog"]);
    assert.equal(await readFile(join(outDirectory, "components/library.html"), "utf8"), source);
    const entry = await readFile(join(outDirectory, "vue/index.js"), "utf8");
    assert.match(entry, /default as UiButton/);
    assert.match(entry, /default as UiDialog/);
    assert.match(entry, /default as Button/);
    assert.match(entry, /default as Dialog/);
    assert.doesNotMatch(entry, /export default/);
    assert.match(await readFile(join(outDirectory, "vue/index.d.ts"), "utf8"), /const UiButton/);
    assert.match(await readFile(join(outDirectory, "vue/index.d.ts"), "utf8"), /const Button/);
    const manifest = JSON.parse(await readFile(join(outDirectory, "package.json"), "utf8"));
    assert.equal(manifest.exports["."]["html-next"], "./html-next/index.js");
    assert.equal(manifest.peerDependencies["@nextwebwg/html-next"], `>=${GENERATOR_VERSION}`);
    assert.match(await readFile(join(outDirectory, "html-next/index.js"), "utf8"), /export \{ UiButton \} from "\.\.\/components\/library\.html"/);
  });

  it("writes each controller's typed host beside its source when asked", async () => {
    const root = await mkdtemp(join(tmpdir(), "html-next-package-hosts-"));
    temporary.push(root);
    await writeFile(join(root, "library.html"), '<template component="ui-picker" controller="./picker.js"><defs><event name="pick" type="string"></event></defs><div></div></template>' +
      '<template component="ui-badge"><span></span></template>');
    await writeFile(join(root, "picker.js"), "export default function controller() {}\n");
    const assemble = (hostTypes: boolean) => assembleComponentPackage({ name: "@example/library", version: "1.0.0",
      outDirectory: join(root, hostTypes ? "hosts" : "plain"), components: [{ source: join(root, "library.html") }], hostTypes });
    await assemble(false);
    await assert.rejects(readFile(join(root, "ui-picker.host.d.ts"), "utf8"));
    await assemble(true);
    assert.match(await readFile(join(root, "ui-picker.host.d.ts"), "utf8"), /export interface HostEvents \{\n {2}pick: string;\n\}/);
    await assert.rejects(readFile(join(root, "ui-badge.host.d.ts"), "utf8"));
  });

  it("can publish only HTML sources and a named source entry", async () => {
    const root = await mkdtemp(join(tmpdir(), "html-next-source-package-"));
    temporary.push(root);
    const result = await assembleComponentPackage({ name: "@example/source-library", version: "1.0.0", outDirectory: root,
      sourceOnly: true, components: [{ source: `${fixture}/ui-button.html` }] });
    assert.ok(result.files.includes("html-next/index.js"));
    assert.ok(result.files.includes("components/ui-button.html"));
    assert.ok(!result.files.some((path) => /^(vue|vanilla|dist|styles)\//.test(path)));
    const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    assert.deepEqual(manifest.exports["."], { "html-next": "./html-next/index.js" });
    assert.ok(!(manifest.peerDependencies ?? {})["@nextwebwg/html-next"]);
  });

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
    assert.match(await readFile(`${first.outDirectory}/vue/UiOverlay.vue`, "utf8"), /\(\) => import\('\.\.\/components\/ui-overlay\.js'\)/);
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
