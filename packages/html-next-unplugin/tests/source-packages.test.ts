import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, it } from "vitest";
import { componentSources, sourcePackages } from "../src/source-packages.js";

const temporary: string[] = [];
afterEach(async () => { for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true }); });

async function fixture(exports: unknown) {
  const root = await mkdtemp(join(tmpdir(), "html-next-source-package-"));
  temporary.push(root);
  const library = join(root, "library");
  await mkdir(join(root, "node_modules"));
  await mkdir(join(library, "components", "nested"), { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { controls: "1.0.0" } }));
  await writeFile(join(library, "package.json"), JSON.stringify({ name: "controls", exports }));
  await symlink(library, join(root, "node_modules", "controls"), process.platform === "win32" ? "junction" : "dir");
  return { root: await realpath(root), library: await realpath(library) };
}

it("discovers workspace source folders, excluding controllers, installed dependencies and symlinks", async () => {
  const { root, library } = await fixture({ ".": { "html-next": "./components/" } });
  const folder = join(library, "components");
  await writeFile(join(folder, "button.html"), "Button component");
  await writeFile(join(folder, "nested", "card.html"), "Card component");
  await writeFile(join(folder, "controller.js"), "Controller");
  await mkdir(join(folder, "node_modules"));
  await writeFile(join(folder, "node_modules", "dependency.html"), "Dependency");
  await symlink(join(folder, "button.html"), join(folder, "duplicate.html"));
  const packages = await sourcePackages(root);
  assert.equal(packages.length, 1);
  assert.equal(packages[0]!.directory, library);
  assert.deepEqual(await componentSources(packages[0]!.exports[0]!.source, library), [join(folder, "button.html"), join(folder, "nested", "card.html")]);
});

it("rejects source exports and folder symlinks that escape the library", async () => {
  const { root, library } = await fixture({ ".": { "html-next": "./../outside" } });
  await assert.rejects(sourcePackages(root), /escapes its package/);
  const outside = join(root, "outside");
  await mkdir(outside);
  await symlink(outside, join(library, "external"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(componentSources(join(library, "external"), library), /escapes its package/);
});

it("leaves ordinary packages and wildcard exports to the bundler", async () => {
  const { root } = await fixture({ ".": { import: "./index.js" }, "./*": { "html-next": "./components/*.html" } });
  assert.deepEqual(await sourcePackages(root), []);
  assert.deepEqual(await sourcePackages(join(root, "missing-app")), []);
});
