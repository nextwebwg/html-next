import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, it } from "vitest";

import { compileScript, parse as parseVue } from "@vue/compiler-sfc";
import { build, type Plugin } from "esbuild";

import { assembleFixtureLooma } from "./helpers/looma-package.js";

const enabled = process.env.HTMLNEXT_CONSUMER_TEST === "1";
const run = promisify(execFile);
const repository = new URL("../", import.meta.url).pathname;

describe.skipIf(!enabled)("external package consumer", () => {
  let directory = "";
  let entry = "";
  let bundle = "";

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-consumer-"));
    const looma = join(directory, "looma");
    const consumer = join(directory, "consumer");
    const modules = join(consumer, "node_modules");
    await assembleFixtureLooma(looma);
    await mkdir(join(modules, "@nextwebwg"), { recursive: true });
    await mkdir(join(modules, "@threadlabs"), { recursive: true });
    await symlink(repository, join(modules, "@nextwebwg/html"), "dir");
    await symlink(looma, join(modules, "@threadlabs/looma"), "dir");
    await symlink(resolve(repository, "node_modules/@vue"), join(modules, "@vue"), "dir");
    await symlink(resolve(repository, "node_modules/vue"), join(modules, "vue"), "dir");

    entry = join(consumer, "index.ts");
    await writeFile(entry, `import "@threadlabs/looma";
import "@threadlabs/looma/layout";
import "@threadlabs/looma/styles.css";
import type { ComponentDefinition } from "@nextwebwg/html";
import { definitions } from "@threadlabs/looma";
import { Button, Dialog, FormField, Menu, SearchShell } from "@threadlabs/looma/vue";
import { EditorToolbar } from "@threadlabs/looma/vue/editor";
import { LoomaTable } from "@threadlabs/looma/editor/extensions";
const typed: readonly ComponentDefinition[] = definitions;
export { typed, Button, Dialog, FormField, Menu, SearchShell, EditorToolbar, LoomaTable };
`, "utf8");

    const vuePlugin: Plugin = {
      name: "consumer-vue-sfc",
      setup(context) {
        context.onLoad({ filter: /\.vue$/ }, async ({ path }) => {
          const source = await readFile(path, "utf8");
          const parsed = parseVue(source, { filename: path });
          if (parsed.errors.length > 0) throw parsed.errors[0];
          return {
            contents: compileScript(parsed.descriptor, { id: path, inlineTemplate: true }).content,
            loader: "ts",
            resolveDir: dirname(path),
          };
        });
      },
    };
    bundle = join(consumer, "bundle.mjs");
    await build({
      entryPoints: [entry],
      outfile: bundle,
      bundle: true,
      format: "esm",
      platform: "browser",
      target: ["es2022"],
      preserveSymlinks: true,
      loader: { ".css": "empty" },
      plugins: [vuePlugin],
    });

    await run(resolve(repository, "node_modules/.bin/tsc"), [
      "--noEmit", "--strict", "--skipLibCheck", "--target", "ES2022",
      "--module", "NodeNext", "--moduleResolution", "NodeNext", "--preserveSymlinks", entry,
    ], { cwd: consumer });
  });

  afterAll(async () => {
    if (directory !== "") await rm(directory, { recursive: true, force: true });
  });

  it("resolves public package exports without aliases or consumer shims", async () => {
    const source = await readFile(bundle, "utf8");
    assert.match(source, /fixture-editor|EditorToolbar|loomaTable/);
    assert.match(source, /ui-button/);
    assert.doesNotMatch(source, /from\s+["']@threadlabs\/looma/);
  });

  it("includes every public runtime entry in the publishable package", async () => {
    const { stdout } = await run("npm", ["pack", "--dry-run", "--json"], { cwd: repository });
    const report = JSON.parse(stdout) as Array<{ files: Array<{ path: string }> }>;
    const files = new Set(report[0]!.files.map((file) => file.path));
    for (const path of [
      "dist/index.js", "dist/index.d.ts", "dist/runtime.js", "dist/runtime.d.ts",
      "dist/browser-loader.js", "dist/browser-loader.bundle.js", "dist/browser-loader.d.ts", "dist/node-loader.js",
      "dist/validation.js", "dist/cli.js",
    ]) {
      assert.ok(files.has(path), `npm pack omitted ${path}`);
    }
  });
});
