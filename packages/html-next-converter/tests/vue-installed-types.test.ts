import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { it } from "vitest";

import { assembleComponentPackage } from "@nextwebwg/html-next";

import { convertComponents } from "../src/index.js";

const run = promisify(execFile);
const require = createRequire(new URL("../package.json", import.meta.url));
const checker = require.resolve("vue-tsc/bin/vue-tsc.js");
const modules = fileURLToPath(new URL("../node_modules", import.meta.url));
const shell = process.platform === "win32";

it("infers selected props from an independently installed Vue library's declarations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "html-next-installed-vue-types-"));
  try {
    const source = join(directory, "source");
    const pkg = join(directory, "package");
    const consumer = join(directory, "consumer");
    await Promise.all([mkdir(source), mkdir(pkg), mkdir(consumer)]);
    await symlink(modules, join(pkg, "node_modules"), "dir");
    await writeFile(join(source, "input.html"), `<template component="x-input" status="early" summary="Typed input."><defs>
      <prop name="type" type="keyword" values="text, email, number" default="text">Mode.</prop>
      <prop name="value">Value.<type from="type"><option value="text" type="string"></option><option value="email" type="string"></option><option value="number" type="number"></option></type></prop>
      <prop name="disabled" type="boolean" default="false">Disabled.</prop>
    </defs><input from:type="$type" from:value="$value" from:disabled="$disabled"></template>`);
    await convertComponents({ target: "vue", mode: "library", root: source, outDirectory: pkg, entries: ["input.html"] });
    const compilerOptions = { strict: true, skipLibCheck: true, module: "ESNext", moduleResolution: "Bundler", target: "ES2022", lib: ["ES2022", "DOM", "DOM.Iterable"], allowImportingTsExtensions: true };
    await writeFile(join(pkg, "tsconfig.json"), JSON.stringify({ compilerOptions: { ...compilerOptions, declaration: true, emitDeclarationOnly: true, rootDir: "vue", outDir: "types" }, include: ["vue/**/*.vue", "vue/**/*.ts"] }));
    const check = (cwd: string) => run(process.execPath, [checker, "-p", join(cwd, "tsconfig.json")], { cwd });
    try { await check(pkg); } catch (error) { assert.fail((error as { stdout: string }).stdout); }
    // The published library exposes compiled JavaScript modules, not .vue source imports.
    const types = join(pkg, "types");
    await rename(join(types, "XInput.vue.d.ts"), join(types, "XInput.d.ts"));
    const entry = join(types, "index.d.ts");
    await writeFile(entry, (await readFile(entry, "utf8")).replaceAll(".vue", ".js"));
    await writeFile(join(pkg, "package.json"), JSON.stringify({ name: "@example/vue-input-types", version: "0.0.0", private: true, type: "module", files: ["types"], exports: { ".": "./types/index.d.ts" } }));
    const packed = await run("npm", ["pack", "--json", "--pack-destination", directory], { cwd: pkg, shell });
    await writeFile(join(consumer, "package.json"), JSON.stringify({ name: "vue-input-consumer", private: true, type: "module" }));
    await run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", join(directory, JSON.parse(packed.stdout)[0].filename)], { cwd: consumer, shell });
    await symlink(join(modules, "vue"), join(consumer, "node_modules", "vue"), "dir");
    await writeFile(join(consumer, "tsconfig.json"), JSON.stringify({ compilerOptions: { ...compilerOptions, noEmit: true }, vueCompilerOptions: { strictTemplates: true }, files: ["Consumer.vue"] }));
    const cases: readonly (readonly [string, string, RegExp?])[] = [
      ["selected literals and models", `<script setup lang="ts">import { ref } from 'vue'; import { XInput } from '@example/vue-input-types'; const text = ref<string | null>(''); const number = ref<number | null>(0);</script><template><XInput type="email" value="hello@example.org"/><XInput type="number" :value="42"/><XInput type="email" v-model="text"/><XInput type="number" v-model="number"/><XInput value="default text"/></template>`],
      ["numeric mode rejects strings", `<script setup lang="ts">import { XInput } from '@example/vue-input-types';</script><template><XInput type="number" value="wrong"/></template>`, /string.*number/],
      ["default text mode rejects numbers", `<script setup lang="ts">import { XInput } from '@example/vue-input-types';</script><template><XInput :value="42"/></template>`, /number.*string/],
    ];
    for (const [name, contents, expected] of cases) {
      await writeFile(join(consumer, "Consumer.vue"), contents);
      if (expected === undefined) {
        try { await check(consumer); } catch (error) { assert.fail(`${name}: ${(error as { stdout: string }).stdout}`); }
      } else {
        await assert.rejects(check(consumer), (error: unknown) => {
          assert.match((error as { stdout: string }).stdout, expected, name);
          return true;
        });
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);

it("types an invocation's literal props as the values the live runtime parses", async () => {
  const directory = await mkdtemp(join(tmpdir(), "html-next-vue-literal-props-"));
  try {
    await symlink(modules, join(directory, "node_modules"), "dir");
    await writeFile(join(directory, "toolbar.html"), `<template component="x-toolbar" status="early" summary="Toolbar."><defs>
      <prop name="floating" type="boolean" default="false">Floats.</prop>
      <prop name="docked" type="boolean" default="true">Docks.</prop>
      <prop name="count" type="number" default="0">Count.</prop>
      <prop name="label" type="string" default="">Label.</prop>
    </defs><div role="toolbar" from:aria-label="$label"><span>{$count}</span></div></template>`);
    await writeFile(join(directory, "editor.html"), `<link rel="component" href="./toolbar.html">
<template component="x-editor" status="early" summary="Editor."><defs></defs><section><x-toolbar floating docked="false" count="3" label="Tools"></x-toolbar></section></template>`);
    await convertComponents({ target: "vue", mode: "application", root: directory, outDirectory: directory, entries: ["editor.html"] });
    const editor = await readFile(join(directory, "vue", "XEditor.vue"), "utf8");
    // A bare boolean attribute is `true`, as HTML presence reads; a string prop stays an attribute.
    assert.match(editor, /<XToolbar :floating="true" :docked="false" :count="3" label="Tools" \/>/);
    await writeFile(join(directory, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, skipLibCheck: true, module: "ESNext",
      moduleResolution: "Bundler", target: "ES2022", lib: ["ES2022", "DOM", "DOM.Iterable"], allowImportingTsExtensions: true, noEmit: true },
      include: ["vue/**/*.vue", "vue/**/*.ts"] }));
    try { await run(process.execPath, [checker, "-p", join(directory, "tsconfig.json")], { cwd: directory }); }
    catch (error) { assert.fail((error as { stdout: string }).stdout); }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);

it("types an invocation's literal props in an assembled package's Vue output", async () => {
  const directory = await mkdtemp(join(tmpdir(), "html-next-vue-package-literal-props-"));
  try {
    const source = join(directory, "source");
    const out = join(directory, "out");
    await mkdir(source);
    await writeFile(join(source, "x-child.html"), `<template component="x-child"><defs>
      <prop name="flag" type="boolean" default="false">A flag.</prop>
      <prop name="count" type="number" default="0">A count.</prop>
    </defs><span>child</span></template>`);
    await writeFile(join(source, "x-frame.html"), `<template component="x-frame"><div><slot></slot></div></template>`);
    // These sources sort before the child they invoke, so assembly reads every contract before generating.
    await writeFile(join(source, "a-direct.html"), `<link rel="component" href="./x-child.html">
<template component="x-direct"><div><x-child flag count="3"></x-child></div></template>`);
    await writeFile(join(source, "a-wrapped.html"), `<link rel="component" href="./x-child.html"><link rel="component" href="./x-frame.html">
<template component="x-wrapped"><x-frame><x-child flag count="3"></x-child></x-frame></template>`);
    await assembleComponentPackage({ name: "literal-props", version: "0.0.0", outDirectory: out,
      components: ["a-direct.html", "a-wrapped.html", "x-child.html", "x-frame.html"].map((file) => ({ source: join(source, file) })) });
    for (const name of ["XDirect", "XWrapped"]) {
      assert.match(await readFile(join(out, "vue", `${name}.vue`), "utf8"), /<XChild :flag="true" :count="3" \/>/);
    }
    await symlink(modules, join(out, "node_modules"), "dir");
    await writeFile(join(out, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, skipLibCheck: true, module: "ESNext",
      moduleResolution: "Bundler", target: "ES2022", lib: ["ES2022", "DOM", "DOM.Iterable"], allowImportingTsExtensions: true, noEmit: true },
      include: ["vue/**/*.vue", "vue/**/*.ts"] }));
    try { await run(process.execPath, [checker, "-p", join(out, "tsconfig.json")], { cwd: out }); }
    catch (error) { assert.fail((error as { stdout: string }).stdout); }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);
