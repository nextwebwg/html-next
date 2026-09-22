import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";

import { compileScript, compileTemplate, parse as parseVue } from "@vue/compiler-sfc";

import {
  convertComponents,
  FrameworkConversionError,
  FrameworkDuplicateEntryError,
  FrameworkOutputCollisionError,
  FrameworkTargetVersionError,
} from "../src/index.js";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "html-next-converter-"));
  temporary.push(root);
  await writeFile(join(root, "package.json"), "{}");
  await writeFile(join(root, "x-card.html"), `<template component="x-card" status="early" summary="Card.">
    <props><prop name="label" type="string" default="Ready">Label.</prop></props>
    <article :aria-label="label"><slot></slot></article>
    <style>:host { display: block; }</style>
  </template>`);
  return root;
}

/** Compiles a converted SFC with Vue's own compiler, failing on any error. */
function compileVue(source: string, filename: string): void {
  const parsed = parseVue(source, { filename });
  assert.deepEqual(parsed.errors, []);
  const script = compileScript(parsed.descriptor, { id: filename, inlineTemplate: true });
  const template = compileTemplate({
    id: filename,
    filename,
    source: parsed.descriptor.template!.content,
    compilerOptions: { bindingMetadata: script.bindings ?? {} },
  });
  assert.deepEqual(template.errors, []);
}

describe("framework converter", () => {
  it("emits a Vue component that imports only Vue", async () => {
    const root = await fixture();
    const outDirectory = join(root, "generated");
    const manifest = await convertComponents({ mode: "application", entries: ["x-card.html"], target: "vue", root, outDirectory });
    const path = join(outDirectory, "vue", "XCard.vue");
    const source = await readFile(path, "utf8");

    compileVue(source, path);
    assert.doesNotMatch(source, /@nextwebwg/);
    assert.deepEqual([...source.matchAll(/^import[^"\n]*"([^"]+)"/gm)].map((match) => match[1]).filter((from) => from !== "vue"), []);
    assert.match(source, /<style scoped>\n\[data-component~="x-card"\] \{\n  display: block;\n\}/);
    assert.equal(manifest.graph, "application");
    assert.deepEqual(manifest.entries, [{ source: "x-card.html", tag: "x-card", artifact: "vue/XCard.vue" }]);
    assert.equal(manifest.output.entry, "vue/application.ts");
    assert.equal(manifest.output.inventory, "html-next.conversion.json");
    assert.equal(await readFile(join(outDirectory, "vue", "application.ts"), "utf8"), 'export { default as XCard } from "./XCard.vue";\n');
  });

  it("maps state, computed values, handlers, and typed events to Vue", async () => {
    const root = await mkdtemp(join(tmpdir(), "html-next-converter-reactive-"));
    temporary.push(root);
    await writeFile(join(root, "counter.html"), `<template component="x-counter" status="early" summary="Counter.">
      <defs>
        <state name="count" :value="0"></state>
        <computed name="double" from="count * 2"></computed>
        <event name="count-change" type="number"></event>
        <handler name="increment">
          <set name="count" :value="count + 1"></set>
          <dispatch event="count-change" :value="count"></dispatch>
        </handler>
      </defs>
      <button :data-count="count" on:click="increment"><output $value="double"></output></button>
    </template>`);
    const outDirectory = join(root, "generated");
    await convertComponents({ mode: "application", entries: ["counter.html"], target: "vue", root, outDirectory });
    const path = join(outDirectory, "vue", "XCounter.vue");
    const source = await readFile(path, "utf8");

    compileVue(source, path);
    assert.doesNotMatch(source, /@nextwebwg/);
    assert.match(source, /const count = ref\(0\);/);
    assert.match(source, /const double = computed\(\(\) => count\.value \* 2\);/);
    assert.match(source, /function increment\(\): void \{\n  count\.value = count\.value \+ 1;\n  dispatch\("count-change", count\.value\);/);
    assert.match(source, /"count-change": \(detail: unknown\) => \(typeof detail === "number" && Number\.isFinite\(detail\)\)/);
    assert.match(source, /:data-count="count"/);
  });

  it("copies the controller beside the component and imports it", async () => {
    const root = await mkdtemp(join(tmpdir(), "html-next-converter-controller-"));
    temporary.push(root);
    await writeFile(join(root, "package.json"), "{}");
    await mkdir(join(root, "components", "x-toggle"), { recursive: true });
    await mkdir(join(root, "components", "shared"), { recursive: true });
    await writeFile(join(root, "components", "x-toggle", "x-toggle.html"), `<template component="x-toggle" status="early" summary="Toggle." controller="./x-toggle.js">
      <defs><state name="on" :value="false"></state></defs>
      <button type="button"><slot></slot></button>
    </template>`);
    await writeFile(join(root, "components", "x-toggle", "x-toggle.js"), 'import { flip } from "../shared/flip.js";\nexport default function controller(host) { host.on("click", () => { host.state.on = flip(host.state.on); }); }\n');
    await writeFile(join(root, "components", "shared", "flip.js"), "export const flip = (value) => !value;\n");
    const outDirectory = join(root, "generated");
    const manifest = await convertComponents({ mode: "library", entries: ["components/x-toggle/x-toggle.html"], target: "vue", root, outDirectory });
    const source = await readFile(join(outDirectory, "vue", "XToggle.vue"), "utf8");

    assert.match(source, /import \* as controllerModule from "\.\/controllers\/x-toggle\/x-toggle\/x-toggle\.js";/);
    assert.equal(manifest.components[0]?.controller, "vue/controllers/x-toggle/x-toggle/x-toggle.js");
    await access(join(outDirectory, "vue", "controllers", "x-toggle", "x-toggle", "x-toggle.js"));
    await access(join(outDirectory, "vue", "controllers", "x-toggle", "shared", "flip.js"));
    assert.ok(manifest.output.artifacts.some(({ path, kind }) => kind === "controller" && path.endsWith("shared/flip.js")));
  });

  for (const mode of ["application", "library"] as const) {
    it(`rejects duplicate ${mode} roots before writing output`, async () => {
      const root = await fixture();
      const outDirectory = join(root, "generated");
      await assert.rejects(
        () => convertComponents({ mode, entries: ["x-card.html", "x-card.html"], target: "vue", root, outDirectory }),
        (error) => error instanceof FrameworkDuplicateEntryError && error.code === "HTC002" && error.source === "x-card.html",
      );
      await assert.rejects(() => access(outDirectory));
    });
  }

  it("reports a source-located diagnostic for semantics Vue conversion does not map yet", async () => {
    const root = await mkdtemp(join(tmpdir(), "html-next-converter-gap-"));
    temporary.push(root);
    await writeFile(join(root, "counter.html"), `<template component="x-counter" status="early" summary="Counter.">
      <defs><state name="markup" value="ready"></state></defs>
      <output $html="markup"></output>
    </template>`);
    await assert.rejects(
      () => convertComponents({ mode: "application", entries: ["counter.html"], target: "vue", root, outDirectory: join(root, "generated") }),
      (error) => error instanceof FrameworkConversionError && error.code === "HTC001" &&
        error.message.includes("counter.html") && error.message.includes("HT032"),
    );
  });

  it("emits a stable public entry for a converted component library", async () => {
    const root = await fixture();
    const outDirectory = join(root, "generated");
    const manifest = await convertComponents({ mode: "library", entries: ["x-card.html"], target: "vue", root, outDirectory });
    assert.equal(manifest.graph, "library");
    assert.equal(manifest.output.entry, "vue/index.ts");
    assert.equal(await readFile(join(outDirectory, "vue", "index.ts"), "utf8"), 'export { default as XCard } from "./XCard.vue";\n');
  });

  it("rejects colliding component names before writing output", async () => {
    const root = await mkdtemp(join(tmpdir(), "html-next-converter-collision-"));
    temporary.push(root);
    await writeFile(join(root, "x-a1.html"), '<template component="x-a1" status="early" summary="First."><div></div></template>');
    await writeFile(join(root, "x-a-1.html"), '<template component="x-a-1" status="early" summary="Second."><div></div></template>');
    const outDirectory = join(root, "generated");
    await assert.rejects(
      () => convertComponents({ mode: "library", entries: ["x-a1.html", "x-a-1.html"], target: "vue", root, outDirectory }),
      (error) => error instanceof FrameworkOutputCollisionError && error.code === "HTC002" &&
        error.artifact === "vue/XA1.vue" && error.sources.includes("x-a1.html") && error.sources.includes("x-a-1.html"),
    );
    await assert.rejects(() => access(outDirectory));
  });

  it("rejects unsupported target versions before loading or writing the graph", async () => {
    const root = await fixture();
    const outDirectory = join(root, "generated");
    await assert.rejects(
      () => convertComponents({ mode: "application", entries: ["missing.html"], target: "vue", targetVersion: "2.7", root, outDirectory }),
      (error) => error instanceof FrameworkTargetVersionError && error.code === "HTC003" && error.supported === "3.5",
    );
    await assert.rejects(() => access(outDirectory));
  });
});
