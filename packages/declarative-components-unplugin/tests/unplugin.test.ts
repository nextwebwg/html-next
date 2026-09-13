import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";
import { build } from "vite";

import { componentsModule, htmlNext } from "../src/index.js";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("HTML Next unplugin", () => {
  it("builds a closed component graph with one shared support import and an inventory", async () => {
    const root = await mkdtemp(join(tmpdir(), "html-next-vite-"));
    temporary.push(root);
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src/counter.html"), `<template component="x-counter" status="early" summary="Counter.">
      <defs>
        <state name="count" :value="0"></state>
        <handler name="increment"><set name="count" :value="count + 1"></set></handler>
      </defs>
      <button on:click="increment"><output $value="count"></output></button>
    </template>`);
    await writeFile(join(root, "src/label.html"), `<template component="x-label" status="early" summary="Label.">
      <props><prop name="label" type="string" default="Ready">Label.</prop></props>
      <output :aria-label="label"></output>
    </template>`);
    await writeFile(join(root, "src/main.js"), `
      import { createXCounter, createXLabel } from ${JSON.stringify(componentsModule)};
      export { createXCounter, createXLabel };
    `);

    await build({
      root,
      logLevel: "silent",
      plugins: [htmlNext.vite({ entries: ["src/counter.html", "src/label.html"], root })],
      resolve: {
        alias: {
          "@nextwebwg/declarative-components/generated-runtime": new URL(
            "../../declarative-components/src/generated-runtime.ts",
            import.meta.url,
          ).pathname,
        },
      },
      build: {
        minify: false,
        lib: {
          entry: join(root, "src/main.js"),
          formats: ["es"],
          fileName: () => "app.js",
          cssFileName: "components",
        },
      },
    });

    const output = await readFile(join(root, "dist/app.js"), "utf8");
    const manifest = JSON.parse(await readFile(join(root, "dist/html-next.manifest.json"), "utf8")) as {
      mode: string;
      capabilities: string[];
      supportImports: string[];
      components: Array<{ tag: string }>;
    };
    assert.doesNotMatch(output, /parse5|source-parser|browser-source/);
    assert.equal((output.match(/function createXCounter/g) ?? []).length, 1);
    assert.equal((output.match(/function createXLabel/g) ?? []).length, 1);
    assert.equal(manifest.mode, "native-application-or-library-build");
    assert.deepEqual(manifest.components.map(({ tag }) => tag), ["x-counter", "x-label"]);
    assert.ok(manifest.capabilities.includes("state"));
    assert.deepEqual(manifest.supportImports, ["@nextwebwg/declarative-components/generated-runtime"]);
  });

  it("rejects an application build without graph entries", async () => {
    const root = await mkdtemp(join(tmpdir(), "html-next-vite-empty-"));
    temporary.push(root);
    await writeFile(join(root, "main.js"), `import ${JSON.stringify(componentsModule)};`);
    await assert.rejects(() => build({
      root,
      logLevel: "silent",
      plugins: [htmlNext.vite({ entries: [], root })],
      build: { lib: { entry: join(root, "main.js"), formats: ["es"] } },
    }), /at least one component entry/);
  });

  it("recompiles changed component sources on a subsequent Vite build", async () => {
    const root = await mkdtemp(join(tmpdir(), "html-next-vite-rebuild-"));
    temporary.push(root);
    const component = join(root, "counter.html");
    await writeFile(component, `<template component="x-counter" status="early" summary="Counter.">
      <output>First</output>
    </template>`);
    await writeFile(join(root, "main.js"), `export { createXCounter } from ${JSON.stringify(componentsModule)};`);
    const plugin = htmlNext.vite({ entries: ["counter.html"], root });
    const buildApp = () => build({
      root,
      logLevel: "silent",
      plugins: [plugin],
      build: {
        minify: false,
        lib: {
          entry: join(root, "main.js"),
          formats: ["es"],
          fileName: () => "app.js",
          cssFileName: "components",
        },
      },
    });

    await buildApp();
    assert.match(await readFile(join(root, "dist/app.js"), "utf8"), /First/);
    await writeFile(component, `<template component="x-counter" status="early" summary="Counter.">
      <output>Second</output>
    </template>`);
    await buildApp();
    const rebuilt = await readFile(join(root, "dist/app.js"), "utf8");
    assert.match(rebuilt, /Second/);
    assert.doesNotMatch(rebuilt, /First/);
  });
});
