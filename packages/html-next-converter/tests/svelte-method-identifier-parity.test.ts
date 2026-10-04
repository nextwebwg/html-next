import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { compile } from "svelte/compiler";
import { describe, it } from "vitest";
import { convertComponents } from "../src/index.js";

const run = promisify(execFile);
const checker = createRequire(new URL("../../html-next-unplugin/package.json", import.meta.url)).resolve("svelte-check/bin/svelte-check");

describe.skipIf(process.env.HTMLNEXT_TARGET_TEST !== "1")("Svelte public method identifiers", () => {
  for (const mode of ["application", "library"] as const) {
    it(`${mode} preserves a CSS-valid method name in public consumer types`, async () => {
      const root = await mkdtemp(join(tmpdir(), "html-next-svelte-method-name-"));
      try {
        await symlink(fileURLToPath(new URL("../node_modules", import.meta.url)), join(root, "node_modules"), "dir");
        await writeFile(join(root, "method.html"), `<template component="x-method-name"><defs>
          <method name="·ping" returns="promise(number)"></method>
          <method name="my-method" returns="promise(string)"></method></defs><button>Ready</button></template>`);
        const output = join(root, "output");
        const manifest = await convertComponents({ mode, target: "svelte", root, outDirectory: output, entries: ["method.html"] });
        const artifact = manifest.components[0]!.artifact;
        const source = await readFile(join(output, artifact), "utf8");
        compile(source, { filename: "XMethodName.svelte", generate: "client" });
        compile(source, { filename: "XMethodName.svelte", generate: "server" });
        await writeFile(join(output, "Consumer.svelte"), `<script lang="ts">import Component from './${artifact}';
          let instance: ReturnType<typeof Component>;
          function ping(): Promise<number> { return instance['·ping'](); }
          function named(): Promise<string> { return instance['my-method'](); }
          </script><Component bind:this={instance} />`);
        const config = join(output, "tsconfig.json");
        await writeFile(config, JSON.stringify({ compilerOptions: { strict: true, skipLibCheck: true,
          module: "ESNext", moduleResolution: "Bundler", target: "ES2022", allowJs: true }, include: ["**/*.svelte", "**/*.ts"] }));
        try { await run(process.execPath, [checker, "--tsconfig", config, "--output", "machine"], { cwd: output }); }
        catch (error) { assert.fail(`${mode} public method types: ${(error as { stdout: string }).stdout}`); }
        await writeFile(join(output, "Consumer.svelte"), `<script lang="ts">import Component from './${artifact}';
          let instance: ReturnType<typeof Component>;
          function wrong(): Promise<boolean> { return instance['·ping'](); }
          </script><Component bind:this={instance} />`);
        await assert.rejects(run(process.execPath, [checker, "--tsconfig", config, "--output", "machine"], { cwd: output }), (error: unknown) => {
          assert.match((error as { stdout: string }).stdout, /number.*boolean/);
          return true;
        });
      } finally { await rm(root, { recursive: true, force: true }); }
    });
  }
});
