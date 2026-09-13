import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";

import { compileScript, compileTemplate, parse as parseVue } from "@vue/compiler-sfc";
import { transform } from "esbuild";
import { compile as compileSvelte } from "svelte/compiler";

import {
  convertComponents,
  FrameworkConversionError,
  type FrameworkTarget,
} from "../src/index.js";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "html-next-converter-"));
  temporary.push(root);
  await writeFile(join(root, "x-card.html"), `<template component="x-card" status="early" summary="Card.">
    <props><prop name="label" type="string" default="Ready">Label.</prop></props>
    <article :aria-label="label"><slot></slot></article>
    <style>article { display: block; }</style>
  </template>`);
  return root;
}

describe("framework converter", () => {
  for (const target of ["react", "vue", "svelte"] as const) {
    it(`emits a ${target}-native component without the general runtime`, async () => {
      const root = await fixture();
      const outDirectory = join(root, "generated");
      const manifest = await convertComponents({ entries: ["x-card.html"], target, root, outDirectory });
      const extension: Readonly<Record<FrameworkTarget, string>> = {
        react: "tsx",
        vue: "vue",
        svelte: "svelte",
      };
      const path = join(outDirectory, target, `XCard.${extension[target]}`);
      const source = await readFile(path, "utf8");
      assert.doesNotMatch(source, /declarative-components\/runtime|attachComponent/);
      assert.deepEqual(manifest.components[0]?.bridges, []);

      if (target === "react") await transform(source, { loader: "tsx" });
      if (target === "vue") {
        const parsed = parseVue(source, { filename: path });
        assert.deepEqual(parsed.errors, []);
        const script = compileScript(parsed.descriptor, { id: "x-card" });
        const template = compileTemplate({
          id: "x-card",
          filename: path,
          source: parsed.descriptor.template!.content,
          compilerOptions: { bindingMetadata: script.bindings ?? {} },
        });
        assert.deepEqual(template.errors, []);
      }
      if (target === "svelte") {
        assert.ok(compileSvelte(source, { filename: path, generate: "client" }).js.code.length > 0);
      }
    });
  }

  for (const target of ["react", "vue", "svelte"] as const) {
    it(`maps counter state and handlers to ${target} reactivity`, async () => {
      const root = await mkdtemp(join(tmpdir(), "html-next-converter-reactive-"));
      temporary.push(root);
      await writeFile(join(root, "counter.html"), `<template component="x-counter" status="early" summary="Counter.">
        <defs>
          <state name="count" :value="0"></state>
          <computed name="double" from="count * 2"></computed>
          <handler name="increment"><set name="count" :value="count + 1"></set></handler>
        </defs>
        <button :data-count="count" on:click="increment"><output $value="double"></output></button>
      </template>`);
      const outDirectory = join(root, "generated");
      await convertComponents({ entries: ["counter.html"], target, root, outDirectory });
      const extension: Readonly<Record<FrameworkTarget, string>> = {
        react: "tsx",
        vue: "vue",
        svelte: "svelte",
      };
      const path = join(outDirectory, target, `XCounter.${extension[target]}`);
      const source = await readFile(path, "utf8");
      assert.doesNotMatch(source, /declarative-components\/runtime|attachComponent/);
      if (target === "react") {
        assert.match(source, /useState\(0\)/);
        await transform(source, { loader: "tsx" });
      }
      if (target === "vue") {
        assert.match(source, /computed\(\(\) =>/);
        assert.doesNotMatch(source, /:data-count="undefined"/);
        assert.match(source, /:data-count="state0"/);
        const parsed = parseVue(source, { filename: path });
        assert.deepEqual(parsed.errors, []);
        compileScript(parsed.descriptor, { id: "x-counter" });
      }
      if (target === "svelte") {
        assert.match(source, /\$state\(0\)/);
        assert.ok(compileSvelte(source, { filename: path, generate: "client" }).js.code.length > 0);
      }
    });
  }

  it("reports an explicit source-located diagnostic for semantics without a native mapping", async () => {
    const root = await mkdtemp(join(tmpdir(), "html-next-converter-gap-"));
    temporary.push(root);
    await writeFile(join(root, "counter.html"), `<template component="x-counter" status="early" summary="Counter.">
      <defs><state name="markup" value="ready"></state></defs>
      <output $html="markup"></output>
    </template>`);
    await assert.rejects(
      () => convertComponents({
        entries: ["counter.html"],
        target: "react",
        root,
        outDirectory: join(root, "generated"),
      }),
      (error) => error instanceof FrameworkConversionError &&
        error.code === "HTC001" && error.message.includes("counter.html"),
    );
  });
});
