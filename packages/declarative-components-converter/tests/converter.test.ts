import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";

import { compileScript, compileTemplate, parse as parseVue } from "@vue/compiler-sfc";
import { transform } from "esbuild";
import { compile as compileSvelte } from "svelte/compiler";

import {
  convertComponents,
  FrameworkConversionError,
  FrameworkDuplicateEntryError,
  FrameworkOutputCollisionError,
  FrameworkTargetVersionError,
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
      const manifest = await convertComponents({
        mode: "application",
        entries: ["x-card.html"],
        target,
        root,
        outDirectory,
      });
      const extension: Readonly<Record<FrameworkTarget, string>> = {
        react: "tsx",
        vue: "vue",
        svelte: "svelte",
      };
      const path = join(outDirectory, target, `XCard.${extension[target]}`);
      const source = await readFile(path, "utf8");
      assert.doesNotMatch(source, /declarative-components\/runtime|attachComponent/);
      assert.deepEqual(manifest.components[0]?.bridges, []);
      assert.equal(manifest.graph, "application");
      assert.deepEqual(manifest.entries, [{
        source: "x-card.html",
        tag: "x-card",
        artifact: `${target}/XCard.${extension[target]}`,
      }]);
      assert.equal(manifest.output.entry, `${target}/application.ts`);
      assert.equal(manifest.output.inventory, "html-next.conversion.json");
      assert.ok(manifest.output.artifacts.some(({ path, kind }) =>
        path === `${target}/application.ts` && kind === "entry"
      ));
      const entry = await readFile(join(outDirectory, target, "application.ts"), "utf8");
      assert.equal(
        entry,
        target === "react"
          ? 'export { XCard } from "./XCard.js";\n'
          : `export { default as XCard } from "./XCard.${extension[target]}";\n`,
      );

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
          <event name="count-change" type="number"></event>
          <handler name="increment">
            <set name="count" :value="count + 1"></set>
            <dispatch event="count-change" :value="count"></dispatch>
          </handler>
        </defs>
        <button :data-count="count" on:click="increment"><output $value="double"></output></button>
      </template>`);
      const outDirectory = join(root, "generated");
      const manifest = await convertComponents({ mode: "application", entries: ["counter.html"], target, root, outDirectory });
      const extension: Readonly<Record<FrameworkTarget, string>> = {
        react: "tsx",
        vue: "vue",
        svelte: "svelte",
      };
      const path = join(outDirectory, target, `XCounter.${extension[target]}`);
      const source = await readFile(path, "utf8");
      assert.doesNotMatch(source, /declarative-components\/runtime|attachComponent/);
      assert.deepEqual(manifest.components[0]?.bridges, ["dom-event-callback", "typed-event-validation"]);
      assert.match(source, /dispatchGeneratedEvent/);
      if (target === "react") {
        assert.match(source, /useState\(0\)/);
        assert.match(source, /currentstate0\.current = nextstate0/);
        assert.match(source, /dispatchGeneratedEvent\(root\.current, \{ name: "count-change"/);
        assert.ok(
          source.indexOf("currentstate0.current = nextstate0") <
            source.indexOf('dispatchGeneratedEvent(root.current, { name: "count-change"'),
          "React commits its synchronous state ref before observers receive the declared event",
        );
        await transform(source, { loader: "tsx" });
      }
      if (target === "vue") {
        assert.match(source, /computed\(\(\) =>/);
        assert.doesNotMatch(source, /:data-count="undefined"/);
        assert.match(source, /:data-count="state0"/);
        assert.match(source, /dispatchGeneratedEvent\(root\.value, \{ name: "count-change"/);
        const parsed = parseVue(source, { filename: path });
        assert.deepEqual(parsed.errors, []);
        compileScript(parsed.descriptor, { id: "x-counter" });
      }
      if (target === "svelte") {
        assert.match(source, /\$state\(0\)/);
        assert.match(source, /dispatchGeneratedEvent\(root, \{ name: "count-change"/);
        assert.ok(compileSvelte(source, { filename: path, generate: "client" }).js.code.length > 0);
      }
    });
  }

  for (const mode of ["application", "library"] as const) {
    for (const target of ["react", "vue", "svelte"] as const) {
      it(`rejects duplicate ${mode} roots for ${target} before writing output`, async () => {
        const root = await fixture();
        const outDirectory = join(root, "generated");
        await assert.rejects(
          () => convertComponents({
            mode,
            entries: ["x-card.html", "x-card.html"],
            target,
            root,
            outDirectory,
          }),
          (error) => error instanceof FrameworkDuplicateEntryError &&
            error.code === "HTC002" && error.source === "x-card.html",
        );
        await assert.rejects(() => access(outDirectory));
      });
    }
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
        mode: "application",
        entries: ["counter.html"],
        target: "react",
        root,
        outDirectory: join(root, "generated"),
      }),
      (error) => error instanceof FrameworkConversionError &&
        error.code === "HTC001" && error.message.includes("counter.html"),
    );
  });

  for (const target of ["react", "vue", "svelte"] as const) {
    it(`emits a stable public entry for a converted ${target} component library`, async () => {
      const root = await fixture();
      const outDirectory = join(root, "generated");
      const manifest = await convertComponents({
        mode: "library",
        entries: ["x-card.html"],
        target,
        root,
        outDirectory,
      });
      const extension: Readonly<Record<FrameworkTarget, string>> = {
        react: "tsx",
        vue: "vue",
        svelte: "svelte",
      };

      assert.equal(manifest.graph, "library");
      assert.equal(manifest.output.entry, `${target}/index.ts`);
      assert.equal(
        await readFile(join(outDirectory, target, "index.ts"), "utf8"),
        target === "react"
          ? 'export { XCard } from "./XCard.js";\n'
          : `export { default as XCard } from "./XCard.${extension[target]}";\n`,
      );
    });

    it(`rejects colliding ${target} component names before writing output`, async () => {
      const root = await mkdtemp(join(tmpdir(), "html-next-converter-collision-"));
      temporary.push(root);
      await writeFile(join(root, "x-a1.html"),
        '<template component="x-a1" status="early" summary="First."><div></div></template>');
      await writeFile(join(root, "x-a-1.html"),
        '<template component="x-a-1" status="early" summary="Second."><div></div></template>');
      const outDirectory = join(root, "generated");
      const extension: Readonly<Record<FrameworkTarget, string>> = {
        react: "tsx",
        vue: "vue",
        svelte: "svelte",
      };

      await assert.rejects(
        () => convertComponents({
          mode: "library",
          entries: ["x-a1.html", "x-a-1.html"],
          target,
          root,
          outDirectory,
        }),
        (error) => error instanceof FrameworkOutputCollisionError &&
          error.code === "HTC002" &&
          error.artifact === `${target}/XA1.${extension[target]}` &&
          error.sources.includes("x-a1.html") && error.sources.includes("x-a-1.html"),
      );
      await assert.rejects(() => access(outDirectory));
    });
  }

  it("rejects unsupported target versions before loading or writing the graph", async () => {
    const root = await fixture();
    const outDirectory = join(root, "generated");

    await assert.rejects(
      () => convertComponents({
        mode: "application",
        entries: ["missing.html"],
        target: "react",
        targetVersion: "18",
        root,
        outDirectory,
      }),
      (error) => error instanceof FrameworkTargetVersionError &&
        error.code === "HTC003" && error.supported === "19",
    );
    await assert.rejects(() => access(outDirectory));
  });
});
